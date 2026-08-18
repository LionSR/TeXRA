import type { SessionHandle } from '@agent/runtime';
import { createSessionStores } from '@controllers/session/sessionStores';
import { createLog } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';
import { toLogData } from './desktopLogUtils.js';

/**
 * Load the process-owned desktop stores and attach their lifecycle hooks.
 */
export async function initializeDesktopProcessStores(session: SessionHandle) {
  const logger = createLog('DesktopProcessStores');
  const stores = createSessionStores(session);
  await stores.sweepLeftoverStreams();
  const streamIncarnations = new Map<StreamTabId, number>();
  const pendingRemovals = new Map<StreamTabId, number>();

  const detachStreamRemoval = session.events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      if (sessionEvent.event.type === 'setActiveStream') {
        const { streamId } = sessionEvent.event.payload;
        if (
          !streamId ||
          !pendingRemovals.has(streamId) ||
          session.snapshots.getRunMetadata(streamId, { quiet: true }).identity
            ?.kind !== 'multiAgentWorkflow' ||
          !session.executions.getAgentHandleByStream(streamId)
        ) {
          return;
        }
        streamIncarnations.set(
          streamId,
          (streamIncarnations.get(streamId) ?? 0) + 1,
        );
        return;
      }
      if (sessionEvent.event.type === 'removeStream') {
        const { streamId } = sessionEvent.event.payload;
        const expectedIncarnation = streamIncarnations.get(streamId) ?? 0;
        pendingRemovals.set(streamId, expectedIncarnation);
        // A live ProgressBackend claims this incarnation synchronously during
        // fact dispatch, before its deletion preparation reaches an await.
        // Check in the following microtask so the process fallback runs only
        // when no presentation owns the removal.
        queueMicrotask(() => {
          if (stores.hasStreamDeletionClaim(streamId)) {
            if (pendingRemovals.get(streamId) === expectedIncarnation) {
              pendingRemovals.delete(streamId);
            }
            return;
          }
          void stores
            .deleteStreamAfterOwnedExecutionRelease(streamId, {
              shouldDelete: () =>
                (streamIncarnations.get(streamId) ?? 0) === expectedIncarnation,
              expectedIncarnation,
            })
            .then((outcome) => {
              if (outcome === 'superseded') {
                logger.info(
                  `Skipped deletion for re-claimed desktop stream ${streamId}`,
                );
              }
            })
            .catch((error: unknown) => {
              logger.warn('Failed to delete a headless desktop stream', {
                data: toLogData(error),
              });
            })
            .finally(() => {
              if (pendingRemovals.get(streamId) === expectedIncarnation) {
                pendingRemovals.delete(streamId);
              }
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
