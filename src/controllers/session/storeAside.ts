/**
 * The session store's aside copies: the file-level moves that keep a copy
 * of a store beside it (a pre-1.0 store retired to `.pre1`, a damaged file
 * moved to `.corrupt-<stamp>`), each at a name no earlier copy holds and
 * removed after 30 days, and the test of whether a failed open is SQLite
 * reporting the file damaged.
 */
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  type Cause,
  Clock,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schedule,
} from 'effect';
import { isSqlError } from 'effect/sql/SqlError';
import { withLogChannel } from '@logger/effectLog';
import type * as SqlClient from 'effect/sql/SqlClient';

export type Sql = SqlClient.SqlClient;

export const run = (sql: Sql, statement: string) => sql.unsafe(statement, []);

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
    const taken = yield* Effect.forEach(['', '-wal', '-shm'], (suffix) =>
      fs.exists(`${name}${suffix}`),
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
  const staged = `${base}.${randomUUID()}.partial`;
  yield* sql.unsafe('VACUUM INTO ?', [staged]);
  yield* run(sql, 'BEGIN IMMEDIATE');
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
    Effect.onError(() =>
      Effect.all([
        run(sql, 'ROLLBACK').pipe(Effect.ignore),
        fs.remove(staged, { force: true }).pipe(Effect.ignore),
      ]),
    ),
  );
  if (moved === null) {
    yield* run(sql, 'ROLLBACK');
    yield* fs.remove(staged, { force: true });
    return null;
  }
  yield* run(sql, 'COMMIT');
  return moved;
});

/** An aside copy beside the store: its kind (a pre-1.0 build's `.format<N>`
 *  among them), the stamp a `.corrupt-` copy is dated by (a rename keeps the
 *  damaged file's mtime), the `.<n>` of a taken name, and a moved WAL or
 *  shared-memory file. */
const ASIDE = /^\.(?:(format\d+)|pre1|corrupt-(\d+))(?:\.\d+)?(?:-wal|-shm)?$/;
const ASIDE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The old aside copies beside the store at `filename`, with their sizes:
 * this build's over 30 days old, and every pre-1.0 build's `.format<N>`
 * history copy (`legacy`), which no build reads and which only
 * `texra doctor --prune-storage` removes, once the user confirms (owner
 * ruling Q4).
 */
export const oldAsides = Effect.fnUntraced(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const old: { path: string; bytes: number; legacy: boolean }[] = [];
  for (const name of yield* fs.readDirectory(dirname(filename))) {
    const match = ASIDE.exec(name.slice(basename(filename).length));
    if (!name.startsWith(basename(filename)) || match === null) continue;
    const path = join(dirname(filename), name);
    const info = yield* fs.stat(path);
    const at = match[2]
      ? Number(match[2])
      : Option.getOrElse(info.mtime, () => new Date(now)).getTime();
    if (match[1] || now - at > ASIDE_RETENTION_MS)
      old.push({ path, bytes: Number(info.size), legacy: !!match[1] });
  }
  return old;
});

/** Remove the aside copies this build writes (`.pre1`, `.corrupt-`) beside
 *  the store at `filename` once over 30 days old, logging each path and size
 *  (the storage design's §7). */
export const removeOldAsides = Effect.fnUntraced(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const { path, bytes, legacy } of yield* oldAsides(filename)) {
    if (legacy) continue;
    yield* fs.remove(path, { force: true });
    yield* Effect.logInfo(
      `Removed ${path} (${bytes} bytes), an aside copy of the session store over 30 days old.`,
    ).pipe(withLogChannel('sessionDatabase'));
  }
});

/** Whether a failed open is SQLite reporting the file damaged or foreign:
 *  `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB` (26), as a driver defect or a
 *  statement's classified cause. */
export function isDamaged(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (reason._tag === 'Interrupt') return false;
    let error: unknown = reason._tag === 'Fail' ? reason.error : reason.defect;
    while (error !== null && typeof error === 'object') {
      const code = (error as { errcode?: unknown }).errcode;
      if (typeof code === 'number') return [11, 26].includes(code & 0xff);
      error =
        (error as { reason?: { cause?: unknown } }).reason?.cause ??
        (error as { cause?: unknown }).cause;
    }
    return false;
  });
}
