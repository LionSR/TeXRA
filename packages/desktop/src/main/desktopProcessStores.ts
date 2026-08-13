import { createChannelTrace } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime';
import { createSessionStores } from '@controllers/session/sessionStores';
import { toLogData } from './desktopLogUtils.js';

/**
 * Load the process-owned desktop stores and attach their lifecycle hooks.
 */
export async function initializeDesktopProcessStores(session: SessionHandle) {
  const logger = createChannelTrace('DesktopProcessStores');
  const stores = createSessionStores(session);
  await stores.sweepLeftoverStreams();

  const detachStreamRemoval = session.events.subscribe(
    (sessionEvent) => {
      if (
        sessionEvent.scope === 'session' &&
        sessionEvent.event.type === 'removeStream'
      ) {
        const { streamId } = sessionEvent.event.payload;
        // SessionStores tracks the lease barrier immediately so a window
        // reattaching before terminal artifact persistence finishes cannot
        // replay a stream already marked removed.
        void stores
          .deleteStreamAfterOwnedExecutionRelease(streamId)
          .catch((error: unknown) => {
            logger.warn('Failed to delete a headless desktop stream', {
              data: toLogData(error),
            });
          });
      }
    },
    { scope: 'session' },
  );
  const detachArtifactFlusher = session.useArtifactFlusher(async () => {
    await stores.flushSnapshotsAfterStartedDeletions();
  });
  return {
    stores,
    dispose() {
      detachStreamRemoval();
      detachArtifactFlusher();
    },
  };
}
