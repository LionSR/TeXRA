/**
 * A root's current values and input history
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §9):
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
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { withLogChannel } from '@logger/effectLog';
import { CURRENT_VALUE_VERSION as VALUE_VERSION } from '@shared/schemas';
import {
  CurrentValueNewer,
  InputHistoryRecordSchema,
  INPUT_HISTORY_LIMIT,
  type CurrentValues,
  type Database,
  type DatabaseReadFailed,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import type { ValueFamily } from '@shared/session/valueFamily';
import type { SqlError } from 'effect/sql/SqlError';
import type { SqlRow } from './rowCodec';

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

/** A failed change-feed read's backoff: 250 ms doubling, at most 30 s. */
const READ_RETRY = Schedule.exponential('250 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/** A row a newer build wrote: never decoded as this build's shape. */
const newerValue = (family: string, row: SqlRow) => {
  const version = z.int().parse(row.version);
  return version > VALUE_VERSION
    ? new CurrentValueNewer({ family, key: String(row.key), version })
    : null;
};

/** One current value, decoded by its family's schema: a row that no longer
 *  decodes fails the read naming itself. */
function decodeValue<T>(family: ValueFamily<T, boolean>, row: SqlRow): T {
  const parsed = parseJsonWith(z.string().parse(row.value), family.schema);
  if (Result.isSuccess(parsed)) return parsed.success;
  throw new Error(
    `Stored ${family.name} value ${String(row.key)} does not match its schema: ${parsed.failure.message}`,
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
  readonly transact: <A, E>(
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<A, DatabaseWriteFailed>;
  readonly query: <A, E>(
    read: Effect.Effect<A, E>,
  ) => Effect.Effect<A, DatabaseReadFailed>;
  readonly level: SubscriptionRef.SubscriptionRef<number>;
}): Pick<
  Database['Service'],
  'values' | 'readInputHistory' | 'appendInputHistory'
> {
  const { exec, execOne, transact, query, level } = store;
  /** One value's row; a newer one refuses the read or change. */
  const valueRow = (family: string, key: string) =>
    execOne(
      'SELECT key, version, value FROM current_value WHERE family = ? AND key = ?',
      [family, key],
    ).pipe(
      Effect.flatMap((row) => {
        const newer = row === undefined ? null : newerValue(family, row);
        return newer === null ? Effect.succeed(row) : Effect.fail(newer);
      }),
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
          const value = JSON.stringify(family.schema.parse(next));
          if (row?.value !== value) {
            yield* exec(UPSERT_VALUE, [
              family.name,
              key,
              value,
              yield* Clock.currentTimeMillis,
            ]);
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
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => {
              const newer = newerValue(family.name, row);
              return newer === null
                ? Effect.succeed([
                    {
                      key: z.string().parse(row.key),
                      value: decodeValue(family, row),
                    },
                  ])
                : Effect.logWarning(newer.message).pipe(
                    withLogChannel('sessionDatabase'),
                    Effect.as([]),
                  );
            }),
          ),
          Effect.map((listed) => listed.flat()),
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
                  z.string().parse(row.key),
                  z.string().parse(row.value),
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
    readInputHistory: () =>
      query(
        exec('SELECT at, value FROM input_history ORDER BY id').pipe(
          Effect.map((rows) =>
            rows.map((row) => InputHistoryRecordSchema.parse(row)),
          ),
        ),
      ),
    appendInputHistory: ({ at, value }) =>
      transact(
        Effect.gen(function* () {
          const latest = yield* execOne(
            'SELECT value FROM input_history ORDER BY id DESC LIMIT 1',
          );
          if (latest?.value !== value) {
            yield* exec('INSERT INTO input_history (at, value) VALUES (?, ?)', [
              at,
              value,
            ]);
            yield* exec(
              'DELETE FROM input_history WHERE id NOT IN (SELECT id FROM input_history ORDER BY id DESC LIMIT ?)',
              [INPUT_HISTORY_LIMIT],
            );
          }
        }),
      ),
  };
}
