import type { SessionHandle } from '@agent/runtime';
import { createSessionStores } from '@controllers/session/sessionStores';
import { createLog } from '@logger/logUtils';
import { toLogData } from './desktopLogUtils.js';

/**
 * Load the process-owned desktop stores and attach their lifecycle hooks.
 */
export async function initializeDesktopProcessStores(session: SessionHandle) {
  const logger = createLog('DesktopProcessStores');
  const stores = createSessionStores(session);
  await stores.sweepLeftoverStreams();
  const streamIncarnations = new Map<string, number>();

  const detachStreamRemoval = session.events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      if (sessionEvent.event.type === 'setActiveStream') {
        const { streamId } = sessionEvent.event.payload;
        if (!streamId) return;
        streamIncarnations.set(
          streamId,
          (streamIncarnations.get(streamId) ?? 0) + 1,
        );
        return;
      }
      if (sessionEvent.event.type === 'removeStream') {
        const { streamId } = sessionEvent.event.payload;
        const expectedIncarnation = streamIncarnations.get(streamId) ?? 0;
        // SessionStores tracks the lease barrier immediately so a window
        // reattaching before terminal artifact persistence finishes cannot
        // replay a stream already marked removed.
        void stores
          .deleteStreamAfterOwnedExecutionRelease(streamId, {
            shouldDelete: () =>
              (streamIncarnations.get(streamId) ?? 0) === expectedIncarnation,
          })
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
