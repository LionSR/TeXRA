/**
 * The session store's aside copies: the damaged files a store open renamed
 * beside it (`.corrupt-<stamp>`), kept until a storage prune deletes them;
 * the outermost transaction's busy retry; the test of whether a failed
 * open is SQLite reporting the file damaged; and the failure of a check on
 * what a store holds.
 */
import { basename, dirname, join } from 'node:path';
import {
  type Cause,
  Duration,
  Effect,
  FileSystem,
  Predicate,
  Schedule,
  Schema,
} from 'effect';
import { isSqlError } from 'effect/sql/SqlError';
import type * as SqlClient from 'effect/sql/SqlClient';
import { causeChain } from '@utils/errors/errorMessage';

export type Sql = SqlClient.SqlClient;

/** The store holds something this build cannot work from: a setting SQLite
 *  did not apply, another build's schema, a value that no longer matches
 *  its schema, or a blob that is missing or damaged. The store's caller
 *  wraps it as the open or read that failed. */
export class StoreCheckFailed extends Schema.TaggedError<StoreCheckFailed>()(
  'StoreCheckFailed',
  { message: Schema.String },
) {}

/** A store's file and the two SQLite keeps beside it in WAL mode. */
export const STORE_FILE_SUFFIXES = Object.freeze(['', '-wal', '-shm'] as const);

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

/** Interruption stays; a failure, or SQLite's error raised as a defect (a
 *  ROLLBACK or RELEASE that failed in a transaction's cleanup), becomes
 *  `failed`'s. Any other defect dies: a store's own protocol rejections are
 *  a caller's defect, never a disk failure. */
export function mapDatabaseFailure<E>(failed: (cause: unknown) => E) {
  return <A, EOp, R>(
    operation: Effect.Effect<A, EOp, R>,
  ): Effect.Effect<A, E, R> =>
    operation.pipe(
      Effect.catchDefect((defect) =>
        isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect),
      ),
      Effect.mapError(failed),
    );
}

/** The suffix of a damaged store an open renamed aside (`openStore`), and
 *  of its WAL or shared-memory file. */
const ASIDE = /^\.corrupt-\d+(?:-wal|-shm)?$/;

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
    return causeChain(
      reason._tag === 'Fail' ? reason.error : reason.defect,
    ).some(
      (error) =>
        Predicate.hasProperty(error, 'errcode') &&
        Predicate.isNumber(error.errcode) &&
        codes.includes(error.errcode & 0xff),
    );
  });
}

/** Whether a failed open is SQLite reporting the file damaged or foreign:
 *  `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB` (26). */
export function isDamaged(cause: Cause.Cause<unknown>): boolean {
  return hasSqliteCode(cause, [11, 26]);
}

/** Whether a failed open is SQLite unable to open the file at all
 *  (`SQLITE_CANTOPEN`, 14): for an open that creates no file, no store
 *  there yet. */
export function cannotOpen(cause: Cause.Cause<unknown>): boolean {
  return hasSqliteCode(cause, [14]);
}
