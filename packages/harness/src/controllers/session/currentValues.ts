/**
 * A root's current values: application state, not history, and the one
 * writer of `current_value`. Each family's row is replaced in place in one
 * `BEGIN IMMEDIATE`, and decodes with its family's
 * schema where it is read; a row that no longer decodes fails that read.
 * The store (a project's `Database`, or the global one) hands it its
 * connection's statements and transaction, and the counter of value writes
 * its change feed wakes on: this module moves it for its own writes, the
 * global store's poll for another process's.
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
import type { SqlClient } from 'effect/sql/SqlClient';
import { logFailure } from '@logger/effectLog';
import { CURRENT_VALUE_VERSION } from '@shared/schemas';
import type {
  CurrentValues,
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { ValueFamily } from '@shared/session/valueFamily';
import { CURRENT_VALUE_KIND, UPSERT_KINDS, type SqlRow } from './rowCodec';
import { StoreCheckFailed } from './storeAside';
import type { SqlError } from 'effect/sql/SqlError';

/** Replace one current value in place. The version values are written at
 *  is the store's (`stored_kind`), which the store gate reads. */
const UPSERT_VALUE = `
INSERT INTO current_value (family, key, value, at) VALUES (?, ?, ?, ?)
ON CONFLICT(family, key) DO UPDATE SET
  value = excluded.value, at = excluded.at
`;

/** The keys' rows in key order as one JSON text: equal exactly when no
 *  value changed. */
const SNAPSHOT = `SELECT json_group_array(json_array(key, value) ORDER BY key)
    AS snapshot
  FROM current_value
  WHERE family = ? AND key IN (SELECT value FROM json_each(?))`;

/** What a value write records for the store gate: this build's version. */
const VALUE_KIND = JSON.stringify([
  [CURRENT_VALUE_KIND, CURRENT_VALUE_VERSION],
]);

/** A failed change read's backoff (this feed's and the store's change
 *  poll): 250 ms doubling, at most 30 s. */
export const READ_RETRY = Schedule.exponential('250 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

const decodeString = Schema.decodeUnknownSync(Schema.String);

/** One current value, decoded by its family's schema; one that no longer
 *  decodes fails the read naming itself, as a failure the read's caller
 *  types, never a defect. A newer build's values refuse the store at open
 *  (`storeGate`), so no row read here is one. */
function decodeValue<T>(
  family: ValueFamily<T>,
  row: SqlRow,
): Effect.Effect<T, StoreCheckFailed> {
  const parsed = Schema.decodeUnknownResult(
    Schema.fromJsonString(family.schema),
  )(decodeString(row.value));
  return Result.isSuccess(parsed)
    ? Effect.succeed(parsed.success)
    : Effect.fail(
        new StoreCheckFailed({
          message: `Stored ${family.name} value ${String(row.key)} does not match its schema: ${parsed.failure.message}`,
        }),
      );
}

export function currentValues(store: {
  readonly exec: (
    statement: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly SqlRow[], SqlError>;
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
    Extract<E, DatabaseAggregateClosed> | DatabaseWriteFailed
  >;
  readonly query: <A, E>(
    read: Effect.Effect<A, E>,
  ) => Effect.Effect<A, DatabaseReadFailed>;
  readonly afterCommit: SqlClient['afterCommit'];
  /** Moved once per committed value write. */
  readonly written: SubscriptionRef.SubscriptionRef<number>;
}): CurrentValues {
  const { exec, execOne, transact, query, afterCommit, written } = store;
  const notifyWritten = afterCommit(
    SubscriptionRef.update(written, (count) => count + 1),
  );
  const valueRow = (family: string, key: string) =>
    execOne(
      'SELECT key, value FROM current_value WHERE family = ? AND key = ?',
      [family, key],
    );
  return {
    get: (family, key) =>
      query(
        valueRow(family.name, key).pipe(
          Effect.flatMap((row) =>
            row === undefined ? Effect.undefined : decodeValue(family, row),
          ),
        ),
      ),
    modify: <T, K extends string, A, E>(
      family: ValueFamily<T>,
      keys: readonly K[],
      change: (
        current: Readonly<Record<K, T | undefined>>,
      ) => Result.Result<
        readonly [A] | readonly [A, Readonly<Record<K, T | undefined>>],
        E
      >,
    ) =>
      transact(
        Effect.gen(function* () {
          const rows = new Map<string, SqlRow>();
          const current: Partial<Record<K, T>> = {};
          for (const key of keys) {
            const row = yield* valueRow(family.name, key);
            if (row === undefined) continue;
            rows.set(key, row);
            current[key] = yield* decodeValue(family, row);
          }
          // cast: every key with a row was set above; the others read absent.
          const result = change(current as Readonly<Record<K, T | undefined>>);
          if (Result.isFailure(result) || result.success.length === 1)
            return result;
          const next = result.success[1];
          let deleted = false;
          let upserted = false;
          for (const key of keys) {
            const row = rows.get(key);
            const nextValue = next[key];
            if (nextValue === undefined) {
              if (row === undefined) continue;
              yield* exec(
                'DELETE FROM current_value WHERE family = ? AND key = ?',
                [family.name, key],
              );
              deleted = true;
              continue;
            }
            const value = yield* Schema.encodeEffect(
              Schema.fromJsonString(family.schema),
            )(nextValue);
            if (row?.value === value) continue;
            yield* exec(UPSERT_VALUE, [
              family.name,
              key,
              value,
              yield* Clock.currentTimeMillis,
            ]);
            upserted = true;
          }
          if (upserted) yield* exec(UPSERT_KINDS, [VALUE_KIND]);
          if (upserted || deleted) yield* notifyWritten;
          return result;
        }),
      ).pipe(
        Effect.flatMap(Effect.fromResult),
        Effect.map(([value]) => value),
      ),
    list: (family) =>
      query(
        exec(
          'SELECT key, value FROM current_value WHERE family = ? ORDER BY at DESC',
          [family.name],
        ).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Effect.map(decodeValue(family, row), (value) => ({
                key: decodeString(row.key),
                value,
              })),
            ),
          ),
        ),
      ),
    /** Each wake reads the keys' rows, and only a changed snapshot emits. A
     *  failed read is logged and read again, holding the wake until it
     *  reads (the database poll's own backoff), so no change is missed. */
    changes: (family, keys) =>
      SubscriptionRef.changes(written).pipe(
        Stream.mapEffect(() =>
          execOne(SNAPSHOT, [family.name, JSON.stringify(keys)]).pipe(
            Effect.map((row) => row?.snapshot),
            Effect.tapError(
              logFailure(
                'sessionDatabase',
                `Could not read whether ${keys.join(', ')} changed; retrying.`,
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
}
