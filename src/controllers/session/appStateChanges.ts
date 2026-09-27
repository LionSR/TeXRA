/** The change feed of a root database's app-state keys. */
import { Duration, Effect, Schedule, Stream, SubscriptionRef } from 'effect';
import { z } from 'zod';

import { withLogChannel } from '@logger/effectLog';
import { aggregateId } from '@shared/schemas';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/** A failed marker read's backoff: 250 ms doubling, at most 30 s. */
const READ_RETRY = Schedule.exponential('250 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * A root database's `appStateChanges`, over its wake level and its
 * connection: each wake reads the keys' latest commit (off
 * `event_agg_commit`), and only a new one emits. A failed read is logged
 * and read again, holding the wake until it reads: the marker only moves
 * on a successful read, so no commit goes unobserved.
 */
export const appStateChangeFeed =
  (
    level: SubscriptionRef.SubscriptionRef<number>,
    execOne: (
      statement: string,
      params: readonly unknown[],
    ) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, SqlError>,
  ) =>
  (keys: readonly string[]): Stream.Stream<void> => {
    const ids = JSON.stringify(
      keys.map((key) => aggregateId('app-state', key)),
    );
    const latest = execOne(
      `SELECT MAX("commit") AS "commit" FROM event
       WHERE aggregate_id IN (SELECT value FROM json_each(?))`,
      [ids],
    ).pipe(
      Effect.map((row) =>
        z
          .int()
          .nonnegative()
          .nullable()
          .parse(row?.commit ?? null),
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
      // commit is observed. The backoff is the database poll's own.
      Effect.retry(READ_RETRY),
      Effect.orDie,
    );
    return SubscriptionRef.changes(level).pipe(
      Stream.mapEffect(() => latest),
      Stream.changesWith((a, b) => a === b),
      Stream.as(undefined),
    );
  };
