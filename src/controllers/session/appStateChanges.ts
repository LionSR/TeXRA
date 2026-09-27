/** The change feed of a root database's app-state keys. */
import { Effect, Stream, SubscriptionRef } from 'effect';
import { z } from 'zod';

import { withLogChannel } from '@logger/effectLog';
import { aggregateId } from '@shared/schemas';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/**
 * A root database's `appStateChanges`, over its wake level and its
 * connection: each wake reads the keys' latest commit (off
 * `event_agg_commit`), and only a new one emits. A failed read is -1: one
 * change, logged, then quiet until a read succeeds.
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
      Effect.catch((error) =>
        Effect.logWarning(
          `Could not read whether ${keys.join(', ')} changed; its readers re-read it.`,
        ).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel('sessionDatabase'),
          Effect.as(-1),
        ),
      ),
    );
    return SubscriptionRef.changes(level).pipe(
      Stream.mapEffect(() => latest),
      Stream.changesWith((a, b) => a === b),
      Stream.as(undefined),
    );
  };
