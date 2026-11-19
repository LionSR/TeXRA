/**
 * A root's current values: application state, not history, and the one
 * writer of `current_value`. Each family's row is replaced in place in one
 * `BEGIN IMMEDIATE`, and decodes with its family's
 * schema where it is read; a row that no longer decodes fails that read.
 * The store (a project's `Database`, or the global one) hands it its
 * connection and the counter of value writes its change feed wakes on: this module moves it for its own writes, the
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
import { logFailure } from '@logger/effectLog';
import { CURRENT_VALUE_VERSION } from '@shared/schemas';
import type { CurrentValues } from '@shared/session/database';
import type { ValueFamily } from '@shared/session/valueFamily';
import { CURRENT_VALUE_KIND, UPSERT_KINDS, type SqlRow } from './rowCodec';
import { StoreCheckFailed } from './storeAside';
import type { StoreConnection } from './storeConnection';

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

/** A failed change read's backoff: 250 ms doubling, at most 30 s, eight
 *  times, so it ends after about a minute. */
const READ_RETRY = {
  schedule: Schedule.exponential('250 millis').pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
  ),
  times: 8,
};

/**
 * A read that tells whether something changed (this module's feed, and the
 * global store's poll for another process's commit), as a value to compare
 * with the read before it. One that fails is logged and read again on
 * {@link READ_RETRY}. When the retries end it answers a value equal to no
 * other: the change it could not rule out is reported, and the reader's
 * own read of the store then succeeds or fails where that reader handles
 * it. So a change is never missed and the wait for one always ends.
 */
export const changeRead = <E>(
  read: Effect.Effect<unknown, E>,
  failed: string,
): Effect.Effect<unknown> =>
  read.pipe(
    Effect.tapError(logFailure('sessionDatabase', `${failed}; retrying.`)),
    Effect.retry(READ_RETRY),
    Effect.catch((error) =>
      logFailure(
        'sessionDatabase',
        `${failed} after ${READ_RETRY.times} retries; reporting a change.`,
      )(error).pipe(Effect.as(Symbol('unread'))),
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

/** A next value as the JSON text its row stores. This is the one check of
 *  a written value: one its family's schema does not encode fails the
 *  write naming itself, and nothing of the write is stored. */
const encodeValue = <T>(family: ValueFamily<T>, key: string, value: T) =>
  Schema.encodeEffect(Schema.fromJsonString(family.schema))(value).pipe(
    Effect.mapError(
      (issue) =>
        new StoreCheckFailed({
          message: `The ${family.name} value ${key} does not match its schema: ${issue.message}`,
        }),
    ),
  );

export function currentValues(
  { exec, execOne, transact, query, afterCommit }: StoreConnection,
  /** Moved once per committed value write. */
  written: SubscriptionRef.SubscriptionRef<number>,
): CurrentValues {
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
            const value = yield* encodeValue(family, key, nextValue);
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
    /** Each wake reads the keys' rows, and only a changed snapshot emits; a
     *  snapshot that cannot be read emits ({@link changeRead}). */
    changes: (family, keys) =>
      SubscriptionRef.changes(written).pipe(
        Stream.mapEffect(() =>
          changeRead(
            execOne(SNAPSHOT, [family.name, JSON.stringify(keys)]).pipe(
              Effect.map((row) => row?.snapshot),
            ),
            `Could not read whether ${keys.join(', ')} changed`,
          ),
        ),
        Stream.changes,
        Stream.as(undefined),
      ),
  };
}
