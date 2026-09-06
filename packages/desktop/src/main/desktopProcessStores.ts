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
  // delete, so a stream removed while no window shows it (a child stream's
  // auto-close, the leftover sweep) still leaves storage. A `stream.delete`
  // request deletes through the same store; its per-stream deletion dedup is
  // the one claim there is, whichever path gets there first.
  const removals = effectRuntime().runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        if (event.type !== 'stream.removed') return;
        void stores.deleteStream(event.aggregateId).catch((error: unknown) => {
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
