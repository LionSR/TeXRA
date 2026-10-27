/**
 * The session store's machinery beside `Database`. Its aside copies: the
 * files a store open moved beside it (a pre-1.0 store to `.pre1`, a damaged
 * file to `.corrupt-<stamp>`), each at a name no earlier copy holds and kept
 * until a storage prune deletes them, and the test of whether a failed open
 * is SQLite reporting the file damaged. Its transactions: the one wrapper
 * and its modes, the outermost transaction's two retries (a busy lock, claim
 * owners proven off the lock), and how a failure inside one is reported.
 */
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  type Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Predicate,
  Schedule,
  Schema,
} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import { isSqlError, type SqlError } from 'effect/sql/SqlError';
import type { OwnerId, OwnerLiveness } from '@shared/schemas';
import { DatabaseClaimRefused } from '@shared/session/database';
import type { Row } from 'effect/sql/SqlConnection';

/** The SQLite client a store open works through, before `Database` wraps it. */
export type Sql = SqlClient.SqlClient;

/** Run one statement that takes no parameters, for its effect. */
export const run = (
  sql: Sql,
  statement: string,
): Effect.Effect<readonly Row[], SqlError> => sql.unsafe(statement, []);

/** A cleanup step after a failure, which leaves as itself: the step's own
 *  failure is logged at warn, never raised over it. */
export const cleanup = Effect.ignore({
  log: 'Warn',
  message: 'Session store cleanup failed',
});

/** The value a `PRAGMA` reads back: its first row's column of that name,
 *  undefined when it returns no row. */
export const pragmaValue = (
  sql: Sql,
  pragma: string,
): Effect.Effect<unknown, SqlError> =>
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
/** Run `effect` again on the busy schedule above while it fails with a
 *  busy lock ({@link isBusy}); any other failure, and a lock still busy
 *  after 5 s, leaves as it is. */
export const retryBusy = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.retry({ schedule: BUSY_RETRY, while: isBusy }));

/** The claim owners' liveness verdicts an attempt of the outermost
 *  transaction runs with, each proven off the write lock before it. */
export const ProvenOwners = Context.Reference<
  ReadonlyMap<OwnerId, OwnerLiveness>
>('@texra-ai/harness/session/ProvenOwners', { defaultValue: () => new Map() });

/** A claim met owners its attempt has no verdict for. Raised as a defect,
 *  so no body's error handling swallows it: the outermost transaction rolls
 *  back whole, proves them ({@link provingOwners}), and runs again. */
export class OwnersUnproven {
  readonly owners: readonly OwnerId[];
  constructor(owners: readonly OwnerId[]) {
    this.owners = owners;
  }
}

/** Every one of `owners` proven dead by this attempt (`unprovable` will do
 *  when `single`), or the refusal naming the first that is not. An owner it
 *  has no verdict for restarts the outermost transaction ({@link
 *  provingOwners}). */
export const reclaimable = Effect.fn('storeAside.reclaimable')(function* (
  owners: ReadonlySet<OwnerId>,
  single: boolean,
): Effect.fn.Return<void, DatabaseClaimRefused> {
  const proven = yield* ProvenOwners;
  const unproven = [...owners].filter((owner) => !proven.has(owner));
  if (unproven.length > 0)
    return yield* Effect.die(new OwnersUnproven(unproven));
  for (const ownerId of owners) {
    const verdict = proven.get(ownerId);
    if (verdict === 'alive' || (verdict === 'unprovable' && !single))
      return yield* new DatabaseClaimRefused({ ownerId, verdict });
  }
});

/** Run the outermost transaction's `attempt`; one that met claim owners it
 *  has no verdict for rolled back whole, so they are proven here, off the
 *  write lock, and it runs again with every verdict so far. Each round
 *  proves an owner the last did not, so the rounds end. */
export const provingOwners =
  <R>(prove: (owner: OwnerId) => Effect.Effect<OwnerLiveness, never, R>) =>
  <A, E, R2>(
    attempt: Effect.Effect<A, E, R2>,
    proven: ReadonlyMap<OwnerId, OwnerLiveness> = new Map(),
  ): Effect.Effect<A, E, R | R2> =>
    attempt.pipe(
      Effect.provideService(ProvenOwners, proven),
      Effect.catchDefect((defect) =>
        defect instanceof OwnersUnproven
          ? Effect.flatMap(
              Effect.forEach(
                defect.owners,
                (owner) => Effect.map(prove(owner), (v) => [owner, v] as const),
                { concurrency: 'unbounded' },
              ),
              (verdicts) =>
                provingOwners(prove)(
                  attempt,
                  new Map([...proven, ...verdicts]),
                ),
            )
          : Effect.die(defect),
      ),
    );

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
      ['', '-wal', '-shm'],
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
        run(sql, 'ROLLBACK').pipe(cleanup),
        fs.remove(staged, { force: true }).pipe(cleanup),
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

/** An aside copy beside the store: its kind, the `.<n>` of a taken name,
 *  and a moved WAL or shared-memory file. */
const ASIDE = /^\.(?:pre1|corrupt-\d+)(?:\.\d+)?(?:-wal|-shm)?$/;

/** The aside copies beside the store at `filename`, with their sizes. */
export const asideCopies = Effect.fnUntraced(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const copies: { path: string; bytes: number }[] = [];
  for (const name of yield* fs.readDirectory(dirname(filename))) {
    if (
      !name.startsWith(basename(filename)) ||
      !ASIDE.test(name.slice(basename(filename).length))
    )
      continue;
    const path = join(dirname(filename), name);
    copies.push({ path, bytes: Number((yield* fs.stat(path)).size) });
  }
  return copies;
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

/** The open transaction's mode, null outside one; `derive` (projection
 *  catch-up) takes the write lock and wakes no reader. */
export const TxMode = Context.Reference<'read' | 'write' | 'derive' | null>(
  '@texra-ai/harness/session/TxMode',
  { defaultValue: () => null },
);
/** The `event` table's autoincrement sequence: a non-negative integer. */
const EventSeqSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** The `event` table's high-water mark: the last commit assigned. */
export const HIGH_WATER =
  "SELECT seq FROM sqlite_sequence WHERE name = 'event'";
/** The commit a {@link HIGH_WATER} read names: 0 before the first. */
export const commitFromRows = ([row]: readonly Row[]): number =>
  row === undefined ? 0 : Schema.decodeUnknownSync(EventSeqSchema)(row.seq);

/** Interruption stays; a failure or a driver defect becomes `failed`'s. An
 *  attempt's unproven claim owners stay a defect for the outermost transaction. */
export function mapDatabaseFailure<E>(
  failed: (cause: unknown) => E,
): <A, EOp, R>(operation: Effect.Effect<A, EOp, R>) => Effect.Effect<A, E, R> {
  return <A, EOp, R>(
    operation: Effect.Effect<A, EOp, R>,
  ): Effect.Effect<A, E, R> =>
    operation.pipe(
      Effect.catchDefect((defect) =>
        defect instanceof OwnersUnproven
          ? Effect.die(defect)
          : Effect.fail(defect),
      ),
      Effect.mapError(failed),
    );
}

/**
 * The store's one transaction wrapper, so a nested call of any mode finds
 * the savepoint semaphore its outermost opened; that one's mode is `TxMode`:
 * a read begins deferred, a write or derive immediate. A committed write
 * hands its high-water mark to `published` before its connection goes.
 */
export function storeTransactions(
  sql: Sql,
  published: (commit: number) => Effect.Effect<void>,
): Sql['withTransaction'] {
  return SqlClient.makeWithTransaction({
    transactionService: sql.transactionService,
    spanAttributes: [['db.system.name', 'sqlite']],
    acquireConnection: Effect.fn('Database.acquireConnection')(
      function* (restore) {
        const mode = yield* TxMode;
        const connection = yield* restore(sql.reserve);
        // Runs before the release (added after it): a COMMIT is published
        // before the connection goes, even with an interrupt pending.
        yield* Effect.addFinalizer((exit) =>
          mode === 'write' && Exit.isSuccess(exit)
            ? Effect.gen(function* () {
                yield* published(
                  commitFromRows(
                    yield* connection.executeUnprepared(
                      HIGH_WATER,
                      [],
                      undefined,
                    ),
                  ),
                );
              }).pipe(Effect.orDie)
            : Effect.void,
        );
        return connection;
      },
    ),
    begin: (connection) =>
      Effect.flatMap(TxMode, (mode) =>
        connection.executeUnprepared(
          mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE',
          [],
          undefined,
        ),
      ),
    commit: (connection) =>
      connection.executeUnprepared('COMMIT', [], undefined).pipe(
        Effect.orDie,
        Effect.onError(() =>
          connection
            .executeUnprepared('ROLLBACK', [], undefined)
            .pipe(Effect.orDie),
        ),
      ),
    rollback: (connection) =>
      connection.executeUnprepared('ROLLBACK', [], undefined),
    savepoint: (connection, id) =>
      connection.executeUnprepared(`SAVEPOINT effect_sql_${id}`, [], undefined),
    rollbackSavepoint: (connection, id) =>
      connection.executeUnprepared(
        `ROLLBACK TO SAVEPOINT effect_sql_${id}`,
        [],
        undefined,
      ),
  });
}
