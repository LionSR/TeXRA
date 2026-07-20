// Agent imports
import { createChannelTrace } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

// Controller imports
import { SessionStores } from '@controllers/progressView/backend/state/SessionStores';

// Shared imports
import { STREAM_PHASE } from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

// Tool imports
import { releaseStreamResources } from '@tools/approval';
import { GoalStore } from '@tools/goal';

// Transcript imports
import type { StreamSnapshotStore } from '@transcript';

// Local imports
import { prepareDesktopLegacyStreamImport } from './desktopLegacyStreamImporter.js';
import { toLogData } from './desktopLogUtils.js';

/**
 * Load the process-owned desktop stores in migration-safe order.
 *
 * Claiming legacy identities must be the first step of opening the canonical
 * stores. The same canonical initialization runs when no legacy file exists.
 *
 * Legacy identities must be claimed in the transcript index before orphaned
 * sidecars are swept. The returned callback detaches the snapshot projection
 * during process shutdown.
 */
export async function initializeDesktopProcessStores(options: {
  session: SessionHandle;
  snapshots: StreamSnapshotStore;
  legacyStreamFilePath?: string;
}) {
  const { session, snapshots } = options;
  const { transcripts } = session;
  const logger = createChannelTrace('DesktopLegacyStreamImporter');
  let legacyImport:
    Awaited<ReturnType<typeof prepareDesktopLegacyStreamImport>> | undefined;
  if (options.legacyStreamFilePath) {
    try {
      legacyImport = await prepareDesktopLegacyStreamImport(
        options.legacyStreamFilePath,
        {
          transcriptStreamIds: transcripts.keys(),
          sidecarStreamIds: await snapshots.listPersistedStreams(),
        },
      );
    } catch (error) {
      logger.warn(
        'Retaining unreadable legacy desktop stream state for retry',
        {
          data: toLogData(error),
        },
      );
    }
  }

  for (const streamId of legacyImport?.claims ?? []) {
    transcripts.ensureStream(streamId);
  }
  if ((legacyImport?.claims.length ?? 0) > 0) {
    await transcripts.flush();
  }

  const canonicalStreamIds = transcripts.keys();
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
  await stores.sweepOrphanedStreams(new Set(canonicalStreamIds));
  await snapshots.load(canonicalStreamIds);
  // An unfinished canonical transcript is the process-restart evidence that
  // the prior process owned an in-flight run. Restore that provisional phase
  // before the presentation's lease/resume repair classifies it as waiting or
  // failed; otherwise a failed group closure would still render as READY.
  for (const streamId of transcripts.getUnfinishedStreamIds()) {
    session.status.transition(
      streamId,
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
  }

  if (legacyImport) {
    try {
      await legacyImport.commit(legacyImport.claims);
    } catch (error) {
      logger.warn(
        'Retaining legacy desktop stream state after cleanup failed',
        {
          data: toLogData(error),
        },
      );
    }
  }

  const detachSnapshotEvents = snapshots.attachSessionEvents(session.events);
  const detachStreamRemoval = session.events.subscribe(
    (sessionEvent) => {
      if (
        sessionEvent.scope === 'session' &&
        sessionEvent.event.type === 'removeStream'
      ) {
        void stores
          .deleteStream(sessionEvent.event.payload.streamId)
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
    await stores.waitForPendingStreamDeletions();
    await snapshots.flush();
  });
  return {
    stores,
    dispose() {
      detachStreamRemoval();
      detachSnapshotEvents();
      detachArtifactFlusher();
    },
  };
}
