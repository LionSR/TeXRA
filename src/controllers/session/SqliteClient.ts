/** Effect SQL ownership for the session's single physically rooted connection. */
import { Context, Effect, Exit, Scope, Semaphore, Stream } from 'effect';
import * as Client from 'effect/unstable/sql/SqlClient';
import { classifySqliteError, SqlError } from 'effect/unstable/sql/SqlError';
import * as Statement from 'effect/unstable/sql/Statement';

import type { NativeSqliteConnection } from '@agent/storage/nativeSessionStorage.mjs';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { Connection } from 'effect/unstable/sql/SqlConnection';

const TransactionMode = Context.Reference<'read' | 'write'>(
  'texra/sql/TransactionMode',
  { defaultValue: () => 'write' },
);

/** A read snapshot never acquires SQLite's reserved writer lock. */
export const readTransaction = <A, E, R>(
  client: Client.SqlClient,
  body: Effect.Effect<A, E, R>,
) =>
  client
    .withTransaction(body)
    .pipe(Effect.provideService(TransactionMode, 'read'));

/** Construct one client; the caller's scope owns its native connection. */
export const makeSqliteClient = Effect.fnUntraced(function* (
  native: NativeSqliteConnection,
  onWriteCommitted: (connection: Connection) => Effect.Effect<void, unknown>,
) {
  const run = <A>(operation: () => A) =>
    Effect.try({
      try: operation,
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, {
            message: toErrorMessage(cause),
            operation: 'execute',
          }),
        }),
    });
  const execute: Connection['execute'] = (sql, bindings, transformRows) =>
    Effect.flatMap(Client.SafeIntegers, (safeIntegers) =>
      run(() => {
        const { rows } = native.execute(sql, bindings, { safeIntegers });
        return transformRows ? transformRows(rows) : rows;
      }),
    );
  const values: Connection['executeValues'] = (sql, bindings) =>
    Effect.flatMap(Client.SafeIntegers, (safeIntegers) =>
      run(() => native.values(sql, bindings, { safeIntegers })),
    );
  const connection: Connection = {
    execute,
    executeRaw: (sql, bindings) =>
      Effect.flatMap(Client.SafeIntegers, (safeIntegers) =>
        run(() => native.execute(sql, bindings, { safeIntegers })),
      ),
    executeUnprepared: execute,
    executeValues: values,
    executeValuesUnprepared: values,
    executeStream: (sql, bindings, transformRows) =>
      Stream.unwrap(
        Effect.map(execute(sql, bindings, transformRows), Stream.fromIterable),
      ),
  };
  const semaphore = yield* Semaphore.make(1);
  const acquirer = Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.scope, (scope) =>
      restore(semaphore.take(1)).pipe(
        Effect.tap(() => Scope.addFinalizer(scope, semaphore.release(1))),
        Effect.as(connection),
      ),
    ),
  );
  const client = yield* Client.make({
    acquirer,
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [['db.system.name', 'sqlite']],
  });
  // The official sqlite-do driver installs its backend transaction method at
  // construction in the same way. Only this final client escapes; Effect's
  // native transaction constructor owns nesting, rollback and scope release.
  // https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.112/packages/sql/sqlite-do/src/SqliteClient.ts
  return Object.assign(client, {
    withTransaction: Client.makeWithTransaction({
      transactionService: client.transactionService,
      spanAttributes: [['db.system.name', 'sqlite']],
      acquireConnection: Effect.gen(function* () {
        const scope = yield* Scope.make();
        const connection = yield* Scope.provide(acquirer, scope);
        const mode = yield* TransactionMode;
        // Scope closure sees the committed transaction's exit before pending
        // interruption resumes. Register after acquisition so publication runs
        // before the connection permit is released, including on interruption.
        yield* Scope.addFinalizerExit(scope, (exit) =>
          mode === 'write' && Exit.isSuccess(exit)
            ? Effect.orDie(onWriteCommitted(connection))
            : Effect.void,
        );
        return [scope, connection] as const;
      }),
      begin: (connection) =>
        Effect.flatMap(TransactionMode, (mode) =>
          connection.executeUnprepared(
            mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE',
            [],
            undefined,
          ),
        ),
      commit: (connection) =>
        connection.executeUnprepared('COMMIT', [], undefined),
      rollback: (connection) =>
        connection.executeUnprepared('ROLLBACK', [], undefined),
      savepoint: (connection, id) =>
        connection.executeUnprepared(
          `SAVEPOINT effect_sql_${id}`,
          [],
          undefined,
        ),
      rollbackSavepoint: (connection, id) =>
        connection.executeUnprepared(
          `ROLLBACK TO SAVEPOINT effect_sql_${id}`,
          [],
          undefined,
        ),
    }),
  });
});
