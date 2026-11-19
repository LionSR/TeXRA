/**
 * One store's connection: its statements, its transactions and the store
 * gate, built once by the layer that opened the file and handed whole to
 * everything that runs on it (the current values, the row reader, the
 * projections).
 *
 * The two kinds of store differ in one fact, `shared`. A project store is
 * held exclusively by this process: it never meets another's lock, and what
 * it holds cannot change under it, so its layer runs the gate once at open.
 * The global store is opened by every TeXRA process on the machine: a read
 * or a transaction that meets another process's lock is run again, and
 * every write transaction runs the gate first, since another process can
 * be a newer build.
 */
import { Duration, Effect, Schedule, Scheduler } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import {
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  type DatabaseStoreNewer,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { FactKinds } from '@tools/plugins';
import { storeGate, type SqlRow } from './rowCodec';
import { isBusy, mapDatabaseFailure, type Sql } from './storeAside';

/** A busy read's or transaction's retry: from 5 ms, doubling and jittered,
 *  each sleep at most 250 ms, for at most 5 s. The fiber yields between
 *  attempts, so a lock another process holds never freezes the host thread. */
const BUSY_RETRY = Schedule.exponential('5 millis').pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.millis(250))),
  ),
  Schedule.upTo({ duration: '5 seconds' }),
);

export interface StoreConnection {
  /** The store's path, as its failures name it. */
  readonly path: string;
  /** One statement's rows, untyped until the caller parses them. */
  readonly exec: (
    statement: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly SqlRow[], SqlError>;
  /** The first row a statement returns, if any. */
  readonly execOne: (
    statement: string,
    params?: readonly unknown[],
  ) => Effect.Effect<SqlRow | undefined, SqlError>;
  /** Fails on the first stored kind this build does not read. */
  readonly gate: Effect.Effect<void, SqlError | DatabaseStoreNewer>;
  /**
   * One transaction, its failures as they are. It runs in the client's own
   * transaction, which on a writable connection begins `BEGIN IMMEDIATE`
   * (holding the write lock from its first statement), skips a ROLLBACK
   * SQLite already made and gives a failed COMMIT back typed; inside
   * another it is a savepoint.
   *
   * The driver is synchronous and a body awaits nothing, so the only way
   * another fiber could run between BEGIN and COMMIT is the scheduler
   * taking the fiber off after its step budget. With that off, a
   * transaction is one uninterrupted turn: transactions on this connection
   * run in the order they are called, and none waits for another. On a
   * shared store, one that meets another process's lock runs again whole.
   */
  readonly own: <A, E>(
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | SqlError>;
  /** A transaction whose every failure is `failed`'s. */
  readonly transaction: <A, E, EBody>(
    body: Effect.Effect<A, EBody>,
    failed: (cause: unknown) => E,
  ) => Effect.Effect<A, E>;
  /** A write transaction, behind the gate on a shared store. A
   *  closed-aggregate rejection the body raised leaves as itself; any other
   *  failure is the write's. */
  readonly transact: <A, E>(
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<
    A,
    Extract<E, DatabaseAggregateClosed> | DatabaseWriteFailed
  >;
  /** A read outside a transaction; its failure is the read's. */
  readonly query: <A, E>(
    read: Effect.Effect<A, E>,
  ) => Effect.Effect<A, DatabaseReadFailed>;
  /** A read of several statements, as one snapshot. */
  readonly snapshot: <A, E>(
    read: Effect.Effect<A, E>,
  ) => Effect.Effect<A, DatabaseReadFailed>;
  readonly readFailed: (cause: unknown) => DatabaseReadFailed;
  readonly writeFailed: (cause: unknown) => DatabaseWriteFailed;
  readonly afterCommit: Sql['afterCommit'];
}

/** The connection over an opened store's client. `factKinds` are the
 *  plugin fact kinds the process reads, for the gate. */
export function storeConnection(
  sql: Pick<Sql, 'unsafe' | 'withTransaction' | 'afterCommit'>,
  path: string,
  { shared, factKinds }: { shared: boolean; factKinds: FactKinds },
): StoreConnection {
  const readFailed = (cause: unknown) =>
    new DatabaseReadFailed({ path, cause });
  const writeFailed = (cause: unknown) =>
    new DatabaseWriteFailed({ path, cause });
  const exec: StoreConnection['exec'] = (statement, params) =>
    sql.unsafe<Record<string, unknown>>(statement, params);
  const gate = storeGate(exec, factKinds);
  const retryBusy = <A, E>(effect: Effect.Effect<A, E>) =>
    shared
      ? Effect.retry(effect, { schedule: BUSY_RETRY, while: isBusy })
      : effect;
  const own: StoreConnection['own'] = (body) =>
    retryBusy(
      Effect.provideService(
        sql.withTransaction(body),
        Scheduler.PreventSchedulerYield,
        true,
      ),
    );
  const transaction: StoreConnection['transaction'] = (body, failed) =>
    own(body).pipe(mapDatabaseFailure(failed));
  return {
    path,
    exec,
    execOne: (statement, params) =>
      exec(statement, params).pipe(Effect.map((rows) => rows.at(0))),
    gate,
    own,
    transaction,
    transact: <A, E>(body: Effect.Effect<A, E>) =>
      transaction(shared ? Effect.andThen(gate, body) : body, (cause) =>
        cause instanceof DatabaseAggregateClosed
          ? // cast: only a body raises it, so it is one of its errors.
            (cause as Extract<E, DatabaseAggregateClosed>)
          : writeFailed(cause),
      ),
    query: (read) => retryBusy(read).pipe(mapDatabaseFailure(readFailed)),
    snapshot: (read) => transaction(read, readFailed),
    readFailed,
    writeFailed,
    afterCommit: sql.afterCommit,
  };
}
