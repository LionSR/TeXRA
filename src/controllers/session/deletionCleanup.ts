/** C9 generated-file cleanup, driven only by committed deletion records. */
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { Effect, type Context } from 'effect';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { ensureError } from '@utils/errors/errorMessage';

const log = createLog('DeletionCleanup');

/** Delete whole generated directories. rm removes links within a directory
 *  without following them; the common parent must itself be a directory. */
const removeExecutionDirectories = (
  storage: string,
  executionIds: readonly ExecutionId[],
) =>
  Effect.tryPromise({
    try: async () => {
      const runs = join(storage, WORKSPACE_STORAGE_LAYOUT.runs);
      const parent = await lstat(runs);
      if (!parent.isDirectory()) {
        throw new Error(`Generated-run storage is not a directory: ${runs}`);
      }
      for (const id of executionIds) {
        await rm(join(runs, id), { recursive: true, force: true });
      }
    },
    catch: ensureError,
  }).pipe(Effect.catchIf(isFileNotFoundError, () => Effect.void));

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
