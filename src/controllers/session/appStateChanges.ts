/** The change feed of a root database's current values. */
import { Duration, Effect, Schedule, Stream, SubscriptionRef } from 'effect';
import { z } from 'zod';

import { withLogChannel } from '@logger/effectLog';
import type { CurrentValueFamily } from '@shared/schemas';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/** A failed read's backoff: 250 ms doubling, at most 30 s. */
const READ_RETRY = Schedule.exponential('250 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/** The keys' rows in key order: their text is equal exactly when no value
 *  changed. */
const SNAPSHOT = `SELECT key, value FROM current_value
  WHERE family = ? AND key IN (SELECT value FROM json_each(?))
  ORDER BY key`;

/**
 * A root database's `values.changes`, over its wake level and its
 * connection: each wake reads the keys' current rows, and only a changed
 * snapshot emits. A failed read is logged and read again, holding the wake
 * until it reads, so no change goes unobserved.
 */
export const currentValueChangeFeed =
  (
    level: SubscriptionRef.SubscriptionRef<number>,
    exec: (
      statement: string,
      params: readonly unknown[],
    ) => Effect.Effect<readonly Readonly<Record<string, unknown>>[], SqlError>,
  ) =>
  (
    family: CurrentValueFamily,
    keys: readonly string[],
  ): Stream.Stream<void> => {
    const snapshot = exec(SNAPSHOT, [family, JSON.stringify(keys)]).pipe(
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
      // Until it reads: a wake is never consumed by a failed read, so every
      // change is observed. The backoff is the database poll's own.
      Effect.retry(READ_RETRY),
      Effect.orDie,
    );
    return SubscriptionRef.changes(level).pipe(
      Stream.mapEffect(() => snapshot),
      Stream.changesWith((a, b) => a === b),
      Stream.as(undefined),
    );
  };
