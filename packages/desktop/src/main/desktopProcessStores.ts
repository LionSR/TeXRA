import type { SessionHandle } from '@agent/runtime';
import { createSessionStores } from '@controllers/session/createSessionStores';
import { createLog } from '@logger/logUtils';
import { toLogData } from './desktopLogUtils.js';

/**
 * Load the process-owned desktop stores and attach their lifecycle hooks.
 */
export async function initializeDesktopProcessStores(session: SessionHandle) {
  const logger = createLog('DesktopProcessStores');
  const stores = createSessionStores(session);

  const detachStreamRemoval = session.events.subscribeSessionFacts((fact) => {
    if (fact.type === 'removeStream') {
      const { streamId } = fact.payload;
      // A live ProgressBackend claims this removal synchronously during fact
      // dispatch, before its deletion preparation reaches an await. Check in
      // the following microtask so the process fallback runs only when no
      // presentation owns the removal.
      queueMicrotask(() => {
        if (stores.hasStreamDeletionClaim(streamId)) return;
        void stores.deleteStream(streamId).catch((error: unknown) => {
          logger.warn('Failed to delete a headless desktop stream', {
            data: toLogData(error),
          });
        });
      });
    }
  });
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
