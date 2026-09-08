/** C9 generated-file cleanup, driven only by committed deletion records. */
import { Effect, type Context } from 'effect';

import { createLog } from '@logger/logUtils';
import type { Database } from '@shared/session/database';

const log = createLog('DeletionCleanup');

/** One indexed pass. A failed record stays closed and available for retry. */
export const collectPendingDeletions = Effect.fn('collectPendingDeletions')(
  function* (
    database: Pick<
      Context.Service.Shape<typeof Database>,
      'readListing' | 'collectDeletion' | 'cleanupGeneratedDirectories'
    >,
  ) {
    const listing = yield* database.readListing();
    for (const event of listing) {
      if (event.type !== 'stream.removed') continue;
      yield* database
        .collectDeletion(
          event.aggregateId,
          event.commit,
          database.cleanupGeneratedDirectories,
        )
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn(
                `Deletion cleanup remains pending for ${event.aggregateId}`,
                { data: error },
              );
            }),
          ),
        );
    }
  },
);
