/** C9 generated-file cleanup, driven only by committed deletion records. */
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, type Context } from 'effect';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import type { RunId } from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { isPathWithin } from '@utils/core/pathCore';
import { ensureError } from '@utils/errors/errorMessage';

const log = createLog('DeletionCleanup');

/**
 * Remove each run's run directory under the storage root it was
 * admitted against.
 *
 * Both the storage root and its runs directory are resolved with `realpath`,
 * and the runs directory must resolve to itself: a root that was replaced by
 * a link to somewhere else is refused rather than followed, so a swapped
 * storage directory can never redirect deletion outside admitted storage.
 * Each target is then checked to fall inside the resolved runs directory.
 *
 * A refusal throws, which leaves the deletion record closed and pending
 * instead of collected, so the same tombstone retries once the root is sane.
 *
 * This is resolve-then-check, not the handle-confined deletion the retired
 * native addon performed: a root replaced in the window *between* the resolve
 * and the removal is no longer detected. TeXRA 1.0's file-ownership design
 * owns that remaining contract (#12139).
 */
const removeRunDirectories = (
  storage: string,
  runIds: readonly RunId[],
) =>
  Effect.tryPromise({
    try: async () => {
      const runs = path.join(
        realpathSync.native(storage),
        WORKSPACE_STORAGE_LAYOUT.runs,
      );
      // Throws ENOENT when the runs directory is absent, which the caller
      // below reads as "nothing generated to remove".
      if (realpathSync.native(runs) !== runs) {
        throw new Error(
          `Refusing generated-file cleanup: ${runs} does not resolve to itself`,
        );
      }
      for (const runId of runIds) {
        const target = path.join(runs, runId);
        if (!isPathWithin(runs, target)) {
          log.warn(
            `Refusing to remove ${target}: outside the admitted storage root`,
          );
          continue;
        }
        await rm(target, { recursive: true, force: true });
      }
    },
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
      if (event.type !== 'run.removed') continue;
      yield* database
        .collectDeletion(event.aggregateId, event.commit, (ids) =>
          removeRunDirectories(storage, ids),
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
