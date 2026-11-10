/**
 * Failure modes: cancellation pending at COMMIT leaves a durable setting
 * without a change notification; a nested write notifies before its outer
 * transaction rolls back.
 */
// Third-party imports
import { it } from '@effect/vitest';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { expect } from 'vitest';

// Local imports - store boundary
import { currentValues } from '@controllers/session/currentValues';
import {
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';

it.live(
  'notifies committed settings despite cancellation, never rolled-back ones',
  () =>
    Effect.gen(function* () {
      const sql = yield* SqliteClient.make({
        filename: ':memory:',
        disableWAL: true,
      });
      yield* sql.unsafe(
        `CREATE TABLE current_value (family TEXT, key TEXT, value TEXT,
       at INTEGER, PRIMARY KEY (family, key))`,
      );
      const committed = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      let holdCommit = true;
      const transaction = SqlClient.makeWithTransaction({
        transactionService: sql.transactionService,
        spanAttributes: [['db.system.name', 'sqlite']],
        acquireConnection: (restore) => restore(sql.reserve),
        begin: (connection) =>
          Effect.asVoid(
            connection.executeUnprepared('BEGIN IMMEDIATE', [], undefined),
          ),
        commit: (connection) =>
          Effect.gen(function* () {
            yield* connection.executeUnprepared('COMMIT', [], undefined);
            // The real commit has landed, inside the native transaction's
            // interruption mask; hold its return while cancellation arrives.
            if (holdCommit) {
              holdCommit = false;
              yield* Deferred.succeed(committed, undefined);
              yield* Deferred.await(releaseCommit);
            }
          }),
        rollback: (connection) =>
          Effect.asVoid(
            connection.executeUnprepared('ROLLBACK', [], undefined),
          ),
        savepoint: (connection, id) =>
          Effect.asVoid(
            connection.executeUnprepared(
              `SAVEPOINT effect_sql_${id}`,
              [],
              undefined,
            ),
          ),
        rollbackSavepoint: (connection, id) =>
          Effect.asVoid(
            connection.executeUnprepared(
              `ROLLBACK TO SAVEPOINT effect_sql_${id}`,
              [],
              undefined,
            ),
          ),
      });
      const written = yield* SubscriptionRef.make(0);
      const exec = (statement: string, params?: readonly unknown[]) =>
        sql.unsafe<Record<string, unknown>>(statement, params);
      const store = {
        exec,
        execOne: (statement: string, params?: readonly unknown[]) =>
          Effect.map(exec(statement, params), (rows) => rows.at(0)),
        transact: <A, E>(body: Effect.Effect<A, E>) =>
          transaction(body).pipe(
            Effect.mapError(
              (cause) => new DatabaseWriteFailed({ path: ':memory:', cause }),
            ),
          ),
        query: <A, E>(read: Effect.Effect<A, E>) =>
          read.pipe(
            Effect.mapError(
              (cause) => new DatabaseReadFailed({ path: ':memory:', cause }),
            ),
          ),
        afterCommit: sql.afterCommit,
        written,
        valueWritten: Effect.void,
      };
      const { values } = currentValues(store);
      const family = { name: 'settings', schema: Schema.Boolean };
      const ready = yield* Deferred.make<void>();
      const changed = yield* Deferred.make<boolean>();
      yield* values.changes(family, ['enabled']).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const value = yield* values.get(family, 'enabled');
            if (value === undefined) yield* Deferred.succeed(ready, undefined);
            else yield* Deferred.succeed(changed, value);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const writer = yield* values
        .modify(family, 'enabled', () =>
          Result.succeed([undefined, true] as const),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(committed);
      const interruption = yield* Fiber.interrupt(writer).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);

      expect(Exit.hasInterrupts(yield* Fiber.await(writer))).toBe(true);
      expect(yield* values.get(family, 'enabled')).toBe(true);
      expect(yield* SubscriptionRef.get(written)).toBe(1);
      expect(yield* Deferred.await(changed)).toBe(true);

      const rolledBack = yield* transaction(
        values
          .modify(family, 'enabled', () =>
            Result.succeed([undefined, false] as const),
          )
          .pipe(Effect.andThen(Effect.fail('rollback'))),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(rolledBack)).toBe(true);
      expect(yield* values.get(family, 'enabled')).toBe(true);
      expect(yield* SubscriptionRef.get(written)).toBe(1);
    }).pipe(Effect.provide(Reactivity.layer)),
);
