/** C9 generated-file cleanup, driven only by committed deletion records. */
import * as path from 'node:path';

import {
  Data,
  Effect,
  FileSystem,
  type Context,
  type PlatformError,
} from 'effect';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import type { RunId } from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { isPathWithin } from '@utils/core/pathCore';

const CHANNEL = 'DeletionCleanup';

/** The runs directory does not resolve to itself, so cleanup is refused. */
class GeneratedRootRedirected extends Data.TaggedError(
  'GeneratedRootRedirected',
)<{ readonly message: string }> {}

/**
 * Remove each run's run directory under the storage root it was
 * admitted against.
 *
 * Both the storage root and its runs directory are resolved with `realPath`,
 * and the runs directory must resolve to itself: a root that was replaced by
 * a link to somewhere else is refused rather than followed, so a swapped
 * storage directory can never redirect deletion outside admitted storage.
 * Each target is then checked to fall inside the resolved runs directory.
 *
 * A refusal fails with `GeneratedRootRedirected`, which leaves the deletion
 * record closed and pending instead of collected, so the same tombstone
 * retries once the root is sane.
 *
 * This is resolve-then-check, not the handle-confined deletion the retired
 * native addon performed: a root replaced in the window *between* the resolve
 * and the removal is no longer detected. TeXRA 1.0's file-ownership design
 * owns that remaining contract (#12139).
 */
const removeRunDirectories = (
  fs: FileSystem.FileSystem,
  storage: string,
  runIds: readonly RunId[],
): Effect.Effect<void, PlatformError.PlatformError | GeneratedRootRedirected> =>
  Effect.gen(function* () {
    const runs = path.join(
      yield* fs.realPath(storage),
      WORKSPACE_STORAGE_LAYOUT.runs,
    );
    // Fails NotFound when the runs directory is absent, which the catch
    // below reads as "nothing generated to remove".
    if ((yield* fs.realPath(runs)) !== runs) {
      return yield* new GeneratedRootRedirected({
        message: `Refusing generated-file cleanup: ${runs} does not resolve to itself`,
      });
    }
    yield* Effect.forEach(
      runIds,
      (runId) => {
        const target = path.join(runs, runId);
        if (!isPathWithin(runs, target)) {
          return Effect.logWarning(
            `Refusing to remove ${target}: outside the admitted storage root`,
          ).pipe(withLogChannel(CHANNEL));
        }
        return fs.remove(target, { recursive: true, force: true });
      },
      { discard: true },
    );
  }).pipe(
    Effect.uninterruptible,
    Effect.catchIf(
      (error) =>
        error._tag === 'PlatformError' && error.reason._tag === 'NotFound',
      () => Effect.void,
    ),
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
    const fs = yield* FileSystem.FileSystem;
    const listing = yield* database.readListing();
    for (const event of listing) {
      if (event.type !== 'run.removed') continue;
      yield* database
        .collectDeletion(event.aggregateId, event.commit, (ids) =>
          removeRunDirectories(fs, storage, ids),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Deletion cleanup remains pending for ${event.aggregateId}`,
            ).pipe(
              Effect.annotateLogs({ data: error }),
              withLogChannel(CHANNEL),
            ),
          ),
        );
    }
  },
);
