import { createChannelTrace } from '@agent/trace';
import { SessionStores } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { releaseStreamResources } from '@tools/approval';
import { GoalStore } from '@tools/goal';
import { toLogData } from './desktopLogUtils.js';

/**
 * Load the process-owned desktop stores and attach their lifecycle hooks.
 */
export async function initializeDesktopProcessStores(session: SessionHandle) {
  const { transcripts, snapshots } = session;
  const logger = createChannelTrace('DesktopProcessStores');
  const stores = new SessionStores({
    streamLogs: transcripts,
    snapshots,
    goalEntries: {
      forget: (stream) => GoalStore.forget(stream, session),
      forgetMany: (streams) => GoalStore.forgetMany(streams, session),
    },
    onCanonicalStreamDeleted: (stream) => {
      session.status.clearStream(stream);
      releaseStreamResources(stream, session);
    },
  });
  // Leftover background shells go first: they leave the transcript index the
  // orphan sweep then reads as its live set.
  await stores.sweepEphemeralStreams(new Set(transcripts.keys()));
  await stores.sweepOrphanedStreams(new Set(transcripts.keys()));

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
