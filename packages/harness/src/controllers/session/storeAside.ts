/**
 * The session store's aside copies: the files a store open moved beside it
 * (a pre-1.0 store to `.pre1`, a damaged file to `.corrupt-<stamp>`), each
 * at a name no earlier copy holds and kept until a storage prune deletes
 * them; the outermost transaction's busy retry; and the test of whether a
 * failed open is SQLite reporting the file damaged.
 */
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  type Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Predicate,
  Schedule,
} from 'effect';
import { isSqlError, type SqlError } from 'effect/sql/SqlError';
import type * as SqlClient from 'effect/sql/SqlClient';

export type Sql = SqlClient.SqlClient;

/** A store's file and the two SQLite keeps beside it in WAL mode. */
export const STORE_FILE_SUFFIXES = Object.freeze(['', '-wal', '-shm'] as const);

/** The names an open leaves beside a store: a pre-1.0 store moved aside
 *  whole, a damaged file, and the staged copy `underCopy` makes before it
 *  takes a name. `ASIDE` below matches each, and what goes with it. */
export const asideName = Object.freeze({
  pre1: (filename: string): string => `${filename}.pre1`,
  corrupt: (filename: string, at: number): string =>
    `${filename}.corrupt-${at}`,
  staged: (base: string): string => `${base}.${randomUUID()}.partial`,
});

export const run = (sql: Sql, statement: string) => sql.unsafe(statement, []);

/** Run `body` in a `BEGIN IMMEDIATE` transaction. The ending is
 *  uninterruptible, so the transaction never stays open: a body that
 *  succeeds commits when `keep` holds its value and rolls back otherwise;
 *  a body that fails, or a COMMIT that fails, rolls back and keeps its own
 *  failure. */
export const inImmediateTransaction =
  <A>(sql: Sql, keep: (value: A) => boolean = () => true) =>
  <E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
    Effect.acquireUseRelease(
      run(sql, 'BEGIN IMMEDIATE'),
      () => body,
      (_, exit) => {
        const rollback = run(sql, 'ROLLBACK');
        const abandon = rollback.pipe(
          Effect.ignore({ log: 'Warn', message: 'A ROLLBACK failed' }),
        );
        if (Exit.isFailure(exit)) return abandon;
        if (!keep(exit.value)) return rollback;
        return run(sql, 'COMMIT').pipe(Effect.onError(() => abandon));
      },
    );

export const pragmaValue = (sql: Sql, pragma: string) =>
  sql
    .unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`, [])
    .pipe(Effect.map((rows) => rows[0]?.[pragma]));

/** A busy transaction's retry: from 5 ms, doubling and jittered, each sleep
 *  at most 250 ms, for at most 5 s. The fiber yields between attempts, so
 *  a lock another process holds never freezes the host thread. */
const BUSY_RETRY = Schedule.exponential('5 millis').pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.millis(250))),
  ),
  Schedule.upTo({ duration: '5 seconds' }),
);
/** `SQLITE_BUSY` or `SQLITE_LOCKED`: another connection holds the lock. */
export const isBusy = (error: unknown): boolean =>
  isSqlError(error) && error.reason._tag === 'LockTimeoutError';
export const retryBusy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: BUSY_RETRY, while: isBusy }));

/**
 * The first of `base`, `base.2`, `base.3`, … that names no file (with its
 * `-wal` and `-shm` companions, for a whole database moved aside): an
 * earlier copy is never replaced, on any platform's `rename`.
 */
export const freeName = Effect.fnUntraced(function* (base: string) {
  const fs = yield* FileSystem.FileSystem;
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}.${n}`;
    const taken = yield* Effect.forEach(
      STORE_FILE_SUFFIXES,
      (suffix) => fs.exists(`${name}${suffix}`),
      { concurrency: 'unbounded' },
    );
    if (!taken.some(Boolean)) return name;
  }
});

/**
 * Keep a copy of the store beside it, at the first free name from `base`
 * ({@link freeName}), then run `body` under the write lock only if nothing
 * committed since the copy: `VACUUM INTO` cannot run inside a transaction,
 * so the transaction re-reads `user_version` and `data_version` (which moves
 * on every other connection's commit) and, if either moved, discards the
 * copy and answers null for the caller to start over from what the store
 * now is. The name is chosen under the lock, so two processes retiring one
 * store never pick the same one. Answers the copy's path.
 */
export const underCopy = Effect.fnUntraced(function* <E>(
  sql: Sql,
  base: string,
  body: Effect.Effect<void, E>,
) {
  const fs = yield* FileSystem.FileSystem;
  const stamp = yield* pragmaValue(sql, 'user_version');
  const version = yield* pragmaValue(sql, 'data_version');
  const staged = asideName.staged(base);
  yield* sql.unsafe('VACUUM INTO ?', [staged]);
  // A move commits; a store that changed since the copy rolls back.
  const moved = yield* Effect.gen(function* () {
    if (
      (yield* pragmaValue(sql, 'user_version')) !== stamp ||
      (yield* pragmaValue(sql, 'data_version')) !== version
    ) {
      return null;
    }
    const aside = yield* freeName(base);
    yield* fs.rename(staged, aside);
    yield* body;
    return aside;
  }).pipe(
    inImmediateTransaction(sql, (aside: string | null) => aside !== null),
    Effect.onError(() =>
      fs.remove(staged, { force: true }).pipe(
        Effect.ignore({
          log: 'Warn',
          message: `A staged store copy stays behind: ${staged}`,
        }),
      ),
    ),
  );
  if (moved === null) yield* fs.remove(staged, { force: true });
  return moved;
});

/** An `asideName` suffix, the `.<n>` of a taken name, and a moved WAL or
 *  shared-memory file. Never a staged copy: its name cannot tell one a kill
 *  left behind from one an open holds between its copy and its rename. */
const ASIDE = /^\.(?:pre1|corrupt-\d+)(?:\.\d+)?(?:-wal|-shm)?$/;

/** The aside copies beside the store at `filename`, with their sizes. */
export const asideCopies = Effect.fnUntraced(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = (yield* fs.readDirectory(dirname(filename))).filter(
    (name) =>
      name.startsWith(basename(filename)) &&
      ASIDE.test(name.slice(basename(filename).length)),
  );
  return yield* Effect.forEach(
    names,
    (name) => {
      const path = join(dirname(filename), name);
      return Effect.map(fs.stat(path), (info) => ({
        path,
        bytes: Number(info.size),
      }));
    },
    { concurrency: 'unbounded' },
  );
});

/** Whether `cause` carries a SQLite primary result code among `codes`, as a
 *  driver defect or in a classified failure's cause chain. */
function hasSqliteCode(
  cause: Cause.Cause<unknown>,
  codes: readonly number[],
): boolean {
  return cause.reasons.some((reason) => {
    if (reason._tag === 'Interrupt') return false;
    let error: unknown = reason._tag === 'Fail' ? reason.error : reason.defect;
    while (Predicate.isObjectOrArray(error)) {
      if (
        Predicate.hasProperty(error, 'errcode') &&
        Predicate.isNumber(error.errcode)
      )
        return codes.includes(error.errcode & 0xff);
      const wrapped = Predicate.hasProperty(error, 'reason')
        ? error.reason
        : undefined;
      error =
        (Predicate.hasProperty(wrapped, 'cause') ? wrapped.cause : undefined) ??
        (Predicate.hasProperty(error, 'cause') ? error.cause : undefined);
    }
    return false;
  });
}

/** Whether a failed open is SQLite reporting the file damaged or foreign:
 *  `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB` (26). */
export function isDamaged(cause: Cause.Cause<unknown>): boolean {
  return hasSqliteCode(cause, [11, 26]);
}

/** Whether a failed open is SQLite unable to open the file at all
 *  (`SQLITE_CANTOPEN`, 14): for a read-only probe, no store there yet. */
export function cannotOpen(cause: Cause.Cause<unknown>): boolean {
  return hasSqliteCode(cause, [14]);
}
