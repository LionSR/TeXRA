import { Effect, Fiber, Stream } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { createSessionStores } from '@controllers/session/createSessionStores';
import { createLog } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import { toLogData } from './desktopLogUtils.js';

/**
 * Load the process-owned desktop stores and attach their lifecycle hooks.
 */
export async function initializeDesktopProcessStores(session: SessionHandle) {
  const logger = createLog('DesktopProcessStores');
  const stores = createSessionStores(session);

  // Every `stream.removed` from now on, in commit order: the process-owned
  // delete for a stream no presentation claims.
  const removals = effectRuntime().runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        if (event.type !== 'stream.removed') return;
        const streamId = event.aggregateId;
        // A live ProgressBackend that read this fact first holds the claim;
        // otherwise the store's own delete dedup is the one claim there is.
        if (stores.hasStreamDeletionClaim(streamId)) return;
        void stores.deleteStream(streamId).catch((error: unknown) => {
          logger.warn('Failed to delete a headless desktop stream', {
            data: toLogData(error),
          });
        });
      }),
    ),
  );
  const detachArtifactFlusher = session.useArtifactFlusher(async () => {
    await stores.flushSnapshotsAfterStartedDeletions();
  });
  return {
    stores,
    dispose() {
      effectRuntime().runFork(Fiber.interrupt(removals));
      detachArtifactFlusher();
    },
  };
}
