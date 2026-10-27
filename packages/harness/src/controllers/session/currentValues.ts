/**
 * A root's current values and input history:
 * application state, not history, and the one writer of `current_value` and
 * `input_history`. Each family's row is replaced in place in one
 * `BEGIN IMMEDIATE` with no aggregate claim, and decodes with its family's
 * schema where it is read; a row that no longer decodes fails that read.
 * `Database` hands it the connection's statements, transaction and wake
 * level, over which it also serves the values' change feed.
 */
import {
  Clock,
  Duration,
  Effect,
  Result,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { withLogChannel } from '@logger/effectLog';
import { CURRENT_VALUE_VERSION as VALUE_VERSION } from '@shared/schemas';
import {
  InputHistoryRecordSchema,
  INPUT_HISTORY_LIMIT,
  type CurrentValues,
  type Database,
  type DatabaseClaimRefused,
  type DatabaseNotOwner,
  type DatabaseReadFailed,
  DatabaseStoreNewer,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import type { ValueFamily } from '@shared/session/valueFamily';
import { CURRENT_VALUE_KIND, type SqlRow } from './rowCodec';
import type { Exec } from './rowReader';
import type { SqlError } from 'effect/sql/SqlError';

/** Replace one current value in place. */
const UPSERT_VALUE = `
INSERT INTO current_value (family, key, version, value, at) VALUES (?, ?, ${VALUE_VERSION}, ?, ?)
ON CONFLICT(family, key) DO UPDATE SET
  version = excluded.version, value = excluded.value, at = excluded.at
`;

/** The keys' rows in key order: their text is equal exactly when no value
 *  changed. */
const SNAPSHOT = `SELECT key, value FROM current_value
  WHERE family = ? AND key IN (SELECT value FROM json_each(?))
  ORDER BY key`;

/** A failed change read's backoff (this feed's and the store's change
 *  poll): 250 ms doubling, at most 30 s. */
export const READ_RETRY = Schedule.exponential('250 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

const decodeString = Schema.decodeUnknownSync(Schema.String);
const decodeHistoryRecord = Schema.decodeUnknownSync(InputHistoryRecordSchema);

/** One current value, decoded by its family's schema: a row a newer build
 *  wrote is never read as this build's shape, and one that no longer
 *  decodes fails the read naming itself. */
function decodeValue<T>(family: ValueFamily<T, boolean>, row: SqlRow): T {
  const version = Schema.decodeUnknownSync(Schema.Int)(row.version);
  if (version > VALUE_VERSION)
    throw new DatabaseStoreNewer({ type: CURRENT_VALUE_KIND, version });
  const parsed = Schema.decodeUnknownResult(
    Schema.fromJsonString(family.schema),
  )(decodeString(row.value));
  if (Result.isSuccess(parsed)) return parsed.success;
  throw new Error(
    `Stored ${family.name} value ${String(row.key)} does not match its schema: ${parsed.failure.message}`,
  );
}

/** The `values` and `inputHistory` facets of `Database`, over the statements,
 *  write transaction and wake level the store hands in. */
export function currentValues(store: {
  readonly exec: Exec<SqlError>;
  readonly execOne: (
    statement: string,
    params?: readonly unknown[],
  ) => Effect.Effect<SqlRow | undefined, SqlError>;
  /** A write transaction; an ownership rejection the body raised leaves
   *  as itself. */
  readonly transact: <A, E>(
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<
    A,
    Extract<E, DatabaseNotOwner | DatabaseClaimRefused> | DatabaseWriteFailed
  >;
  readonly query: <A, E>(
    read: Effect.Effect<A, E>,
  ) => Effect.Effect<A, DatabaseReadFailed>;
  readonly level: SubscriptionRef.SubscriptionRef<number>;
  /** Record for the gate that a value was written at this build's version. */
  readonly valueWritten: Effect.Effect<void, SqlError>;
}): Pick<Database['Service'], 'values' | 'inputHistory'> {
  const { exec, execOne, transact, query, level, valueWritten } = store;
  const valueRow = (family: string, key: string) =>
    execOne(
      'SELECT key, version, value FROM current_value WHERE family = ? AND key = ?',
      [family, key],
    );
  const values: CurrentValues = {
    get: (family, key) =>
      query(
        valueRow(family.name, key).pipe(
          Effect.map((row) =>
            row === undefined ? undefined : decodeValue(family, row),
          ),
        ),
      ),
    modify: (family, key, change) =>
      transact(
        Effect.gen(function* () {
          const row = yield* valueRow(family.name, key);
          const result = change(
            row === undefined ? undefined : decodeValue(family, row),
          );
          if (Result.isFailure(result) || result.success.length === 1)
            return result;
          const next = result.success[1];
          if (next === undefined) {
            yield* exec(
              'DELETE FROM current_value WHERE family = ? AND key = ?',
              [family.name, key],
            );
            return result;
          }
          const value = JSON.stringify(
            Schema.decodeUnknownSync(family.schema)(next),
          );
          if (row?.value !== value) {
            yield* exec(UPSERT_VALUE, [
              family.name,
              key,
              value,
              yield* Clock.currentTimeMillis,
            ]);
            yield* valueWritten;
          }
          return result;
        }),
      ).pipe(
        Effect.flatMap(Effect.fromResult),
        Effect.map(([value]) => value),
      ),
    list: (family) =>
      query(
        exec(
          'SELECT key, version, value FROM current_value WHERE family = ? ORDER BY at DESC',
          [family.name],
        ).pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              key: decodeString(row.key),
              value: decodeValue(family, row),
            })),
          ),
        ),
      ),
    /** Each wake reads the keys' rows, and only a changed snapshot emits. A
     *  failed read is logged and read again, holding the wake until it
     *  reads (the database poll's own backoff), so no change is missed. */
    changes: (family, keys) =>
      SubscriptionRef.changes(level).pipe(
        Stream.mapEffect(() =>
          exec(SNAPSHOT, [family.name, JSON.stringify(keys)]).pipe(
            Effect.map((rows) =>
              JSON.stringify(
                rows.map((row) => [
                  decodeString(row.key),
                  decodeString(row.value),
                ]),
              ),
            ),
            Effect.tapError((error) =>
              Effect.logWarning(
                `Could not read whether ${keys.join(', ')} changed; retrying.`,
              ).pipe(
                Effect.annotateLogs({ data: error }),
                withLogChannel('sessionDatabase'),
              ),
            ),
            Effect.retry(READ_RETRY),
            Effect.orDie,
          ),
        ),
        Stream.changes,
        Stream.as(undefined),
      ),
  };
  return {
    values,
    inputHistory: {
      read: query(
        exec('SELECT at, value FROM input_history ORDER BY id').pipe(
          Effect.map((rows) => rows.map((row) => decodeHistoryRecord(row))),
        ),
      ),
      append: ({ at, value }) =>
        transact(
          Effect.gen(function* () {
            const latest = yield* execOne(
              'SELECT value FROM input_history ORDER BY id DESC LIMIT 1',
            );
            if (latest?.value !== value) {
              yield* exec(
                'INSERT INTO input_history (at, value) VALUES (?, ?)',
                [at, value],
              );
              yield* exec(
                'DELETE FROM input_history WHERE id NOT IN (SELECT id FROM input_history ORDER BY id DESC LIMIT ?)',
                [INPUT_HISTORY_LIMIT],
              );
            }
          }),
        ),
    },
  };
}
