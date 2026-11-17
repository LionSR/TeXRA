/**
 * One store's connection: the open, the lock a project store holds, and the
 * transactions every statement of the store runs in. A session's event store
 * (`databaseLayer.ts`) and the process's global store of current values are
 * each built on one. `storeSchema.ts` owns the DDL and the open sequence;
 * this module reads no table.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { isSqlError } from 'effect/sql/SqlError';
import { Effect, Scheduler } from 'effect';
import { ensureError } from '@utils/errors/errorMessage';
import {
  DatabaseAggregateClosed,
  DatabaseOpenFailed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { isBusy, isDamaged, retryBusy } from './storeAside';
import { IN_MEMORY_STORE, openStore } from './storeSchema';

/** The database file of a session root, beside the stores it replaces. */
export const SESSION_DATABASE_FILE = 'texra.db';

/** How a store is opened: a project store, created if absent
 *  (`persistent`) or only opened (`existing`), is held exclusively by this
 *  process for the connection's life; the `global` store is shared across
 *  processes; `ephemeral` runs in memory. */
export type StoreMode = 'persistent' | 'existing' | 'ephemeral' | 'global';

/** Why a project store did not open: another process holds it. */
export const STORE_HELD_MESSAGE =
  'Another TeXRA process holds this project; close it there first.';

/** Interruption stays; a failure, or SQLite's error raised as a defect (a
 *  ROLLBACK or RELEASE that failed in a transaction's cleanup), becomes
 *  `failed`'s. Any other defect dies: the store's own protocol refusals
 *  are a caller's defect, never a disk failure. */
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

/**
 * Open the store under `storage` (in memory for `ephemeral`) for the
 * caller's scope: its statements, its transactions and the failures they
 * leave as.
 */
export const storeConnection = Effect.fnUntraced(function* (
  mode: StoreMode,
  storage: string,
) {
  const path =
    mode === 'ephemeral'
      ? IN_MEMORY_STORE
      : join(storage, SESSION_DATABASE_FILE);
  const openFailed = (cause: unknown): DatabaseOpenFailed =>
    new DatabaseOpenFailed({ path, cause });
  const writeFailed = (cause: unknown): DatabaseWriteFailed =>
    new DatabaseWriteFailed({ path, cause });
  const readFailed = (cause: unknown): DatabaseReadFailed =>
    new DatabaseReadFailed({ path, cause });
  const create = mode !== 'existing';
  const exclusive = mode === 'persistent' || mode === 'existing';
  // The store's directory is made here (not by SQLite, which makes
  // only the file), unless the store must exist already.
  const filename =
    mode === 'ephemeral'
      ? IN_MEMORY_STORE
      : yield* Effect.try({
          try: () => {
            if (create) mkdirSync(storage, { recursive: true });
            return join(realpathSync.native(storage), SESSION_DATABASE_FILE);
          },
          catch: (cause) => openFailed(ensureError(cause)),
        });
  // A project store has one holder, this process, so the driver opens
  // it with no busy wait: a lock another process holds refuses the open
  // instead of waiting out the driver's timeout. The exclusive lock
  // below waits at most the 25 ms slice `prepareStore` leaves set.
  const busyTimeout = exclusive ? 0 : '5 seconds';
  const { sql, movedAside } = yield* openStore(
    SqliteClient.make({
      filename: create
        ? filename
        : `file:${filename.replaceAll(/[%?#]/g, encodeURIComponent)}?mode=rw`,
      disableWAL: mode === 'ephemeral',
      busyTimeout,
    }),
    path,
    filename,
  ).pipe(
    Effect.catchIf(isBusy, () =>
      Effect.fail(openFailed(new Error(STORE_HELD_MESSAGE))),
    ),
    mapDatabaseFailure(openFailed),
  );
  if (exclusive)
    // Taken once and kept for the connection's life: in WAL mode an
    // exclusive holder keeps the wal-index in its own memory, so no
    // other process reads or writes the store until it closes.
    yield* Effect.all([
      sql.unsafe('PRAGMA locking_mode = EXCLUSIVE'),
      sql.unsafe('BEGIN IMMEDIATE'),
      sql.unsafe('COMMIT'),
    ]).pipe(
      Effect.catchIf(isBusy, () =>
        Effect.fail(openFailed(new Error(STORE_HELD_MESSAGE))),
      ),
      mapDatabaseFailure(openFailed),
    );
  /** One statement's rows, untyped until the caller parses them. */
  const exec = (statement: string, params?: readonly unknown[]) =>
    sql.unsafe<Record<string, unknown>>(statement, params);
  // Every body is database-only. It runs in the client's own transaction,
  // which on this writable connection begins `BEGIN IMMEDIATE` (holding
  // the write lock from its first statement), skips a ROLLBACK SQLite
  // already made and gives a failed COMMIT back typed; inside a caller's
  // transaction it is a savepoint. A busy lock, which only the global
  // store's other writers take, runs the transaction again whole; a
  // nested body never meets one, its transaction holding the lock already.
  //
  // The driver is synchronous and a body awaits nothing, so the only way
  // another fiber could run between BEGIN and COMMIT is the scheduler
  // taking the fiber off after its step budget. With that off, a
  // transaction is one uninterrupted turn: transactions on this
  // connection run in the order they are called, and none waits for
  // another.
  const own = <A, E>(body: Effect.Effect<A, E>) =>
    retryBusy(
      Effect.provideService(
        sql.withTransaction(body),
        Scheduler.PreventSchedulerYield,
        true,
      ),
    );
  const transaction = <A, E, EBody>(
    body: Effect.Effect<A, EBody>,
    failed: (cause: unknown) => E,
  ) => own(body).pipe(mapDatabaseFailure(failed));
  return {
    /** The store as its failures name it. */
    path,
    sql,
    /** Set when this open moved a damaged store aside. */
    movedAside,
    exec,
    /** The first row a statement returns, if any. */
    execOne: (statement: string, params?: readonly unknown[]) =>
      exec(statement, params).pipe(Effect.map((rows) => rows.at(0))),
    /** A read outside a transaction. */
    query: <A, E>(
      read: Effect.Effect<A, E>,
    ): Effect.Effect<A, DatabaseReadFailed> =>
      read.pipe(retryBusy, mapDatabaseFailure(readFailed)),
    own,
    transaction,
    /** A write transaction. A closed-aggregate rejection the body raised
     *  leaves as itself; any other failure is the write's. */
    transact: <A, E>(body: Effect.Effect<A, E>) =>
      transaction(body, (cause) =>
        cause instanceof DatabaseAggregateClosed
          ? // cast: only a body raises it, so it is one of its errors.
            (cause as Extract<E, DatabaseAggregateClosed>)
          : writeFailed(cause),
      ),
    openFailed,
    readFailed,
    writeFailed,
  };
});

/** Whether another process has the store open (its exclusive lock is
 *  refused), or the file is no SQLite store at all (NOTADB, CORRUPT). */
export const storeOpenElsewhere = (filename: string) =>
  Effect.scoped(
    Effect.flatMap(
      SqliteClient.make({ filename, disableWAL: true, busyTimeout: 0 }),
      (sql) =>
        Effect.andThen(
          sql.unsafe('PRAGMA locking_mode = EXCLUSIVE'),
          sql.unsafe('BEGIN EXCLUSIVE'),
        ),
    ),
  ).pipe(
    Effect.as('free' as const),
    Effect.catchIf(isBusy, () => Effect.succeed('open' as const)),
    Effect.catchCause((cause) =>
      isDamaged(cause)
        ? Effect.succeed('unreadable' as const)
        : Effect.failCause(cause),
    ),
    Effect.provide(Reactivity.layer),
  );
