// Agent imports
import { createChannelTrace } from '@agent/trace';
import { SessionStores } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

// Tool imports
import { releaseStreamResources } from '@tools/approval';
import { GoalStore } from '@tools/goal';

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
 * sidecars are swept. The returned callback detaches this module's own
 * stream-removal subscription and deletion-ordered flusher during process
 * shutdown; the session owns the snapshot store's projection and flush.
 *
 * A claim retires the legacy row, so the import only runs against a persistent
 * transcript index. A launch degraded to an in-memory index leaves the legacy
 * file untouched for the next healthy one.
 */
export async function initializeDesktopProcessStores(options: {
  session: SessionHandle;
  legacyStreamFilePath?: string;
}) {
  const { session } = options;
  const { transcripts, snapshots } = session;
  const logger = createChannelTrace('DesktopLegacyStreamImporter');
  let legacyImport:
    Awaited<ReturnType<typeof prepareDesktopLegacyStreamImport>> | undefined;
  if (options.legacyStreamFilePath && transcripts.mode.kind !== 'persistent') {
    logger.warn(
      'Deferring the legacy desktop stream import: this launch has no persistent transcript index to claim the legacy identities.',
    );
  } else if (options.legacyStreamFilePath) {
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

  const claims = legacyImport?.claims ?? [];
  for (const streamId of claims) {
    transcripts.ensureStream(streamId);
  }
  if (claims.length > 0) {
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
  if (legacyImport) {
    try {
      await legacyImport.commit(claims);
    } catch (error) {
      logger.warn(
        'Retaining legacy desktop stream state after cleanup failed',
        {
          data: toLogData(error),
        },
      );
    }
  }

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
