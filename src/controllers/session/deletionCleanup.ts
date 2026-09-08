/** C9 generated-file cleanup, driven only by committed deletion records. */
import { realpathSync } from 'node:fs';

import { Effect, type Context } from 'effect';

import * as nativeCleanup from '@agent/storage/nativeGeneratedCleanup.mjs';
import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { ensureError } from '@utils/errors/errorMessage';

const log = createLog('DeletionCleanup');

/** Confine each deletion to its held storage root and join the native worker. */
const removeExecutionDirectories = (
  storage: string,
  executionIds: readonly ExecutionId[],
) =>
  Effect.tryPromise({
    try: () =>
      nativeCleanup.removeExecutionDirectories(
        realpathSync.native(storage),
        WORKSPACE_STORAGE_LAYOUT.runs,
        executionIds,
      ),
    catch: ensureError,
  }).pipe(
    Effect.uninterruptible,
    Effect.catchIf(isFileNotFoundError, () => Effect.void),
  );

/** One indexed pass. A failed record stays closed and available for retry. */
export const collectPendingDeletions = Effect.fn('collectPendingDeletions')(
  function* (
    database: Pick<
      Context.Service.Shape<typeof Database>,
      'readListing' | 'collectDeletion'
    >,
    storage: string,
  ) {
    const listing = yield* database.readListing();
    for (const event of listing) {
      if (event.type !== 'stream.removed') continue;
      yield* database
        .collectDeletion(event.aggregateId, event.commit, (ids) =>
          removeExecutionDirectories(storage, ids),
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
