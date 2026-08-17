/**
 * Execution history and stream sidecars live in separate storage domains.
 * `deleteExecution` therefore exposes a `beforeDelete` hook so callers can
 * remove the transcript and snapshot state before the execution directory.
 *
 * A live host supplies its `SessionStores` cleanup capability, preserving
 * child, goal, status, resource, and UI projections. A caller without a live
 * session uses the targeted persistent implementation below. It never opens
 * or parses the transcript registry, so unrelated corruption and history size
 * cannot block deletion of the requested execution.
 *
 * Cleanup must complete before the execution directory is removed. This keeps
 * a failed sidecar deletion visible to callers instead of reporting a clean
 * history deletion while leaving transcript or snapshot state behind.
 */
import { getExecutionStore } from '@agent/storage';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  clearPersistedStreamParentMetadata,
  deletePersistedStreamLog,
} from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StagedStreamSnapshotDeletion } from './StagedDeletionCoordinator';

const log = createLog('AdjacentStreamCleanup');

/** The single capability history deletion needs from a live session owner. */
export interface AdjacentStreamCleanup {
  deleteAdjacentStreamState(stream: StreamTabId): Promise<void>;
}

/**
 * Detached children have their durable sidecar parent-edge cleared by
 * `stageDeleteStream` itself, but this standalone path attaches no
 * `summaryMetaSink`, so the transcript checkpoint never republishes. Patch
 * it per child so one unreadable journal cannot block clearing the rest.
 */
async function clearChildSummaryParentEdges(
  children: readonly StreamTabId[],
): Promise<void> {
  await Promise.all(
    children.map(async (child) => {
      try {
        await clearPersistedStreamParentMetadata(child);
      } catch (error) {
        log.warn(
          `Child stream ${child}'s summary parent-edge could not be cleared after its parent was deleted: ${toErrorMessage(error)}`,
          { data: error },
        );
      }
    }),
  );
}

/**
 * Delete a persisted stream's transcript and snapshot sidecars as one unit.
 * Snapshot staging is rolled back when authoritative transcript deletion
 * fails, so neither storage domain is left half-deleted.
 */
async function deletePersistedAdjacentStreamState(
  stream: StreamTabId,
  snapshots: StreamSnapshotStore,
): Promise<void> {
  const snapshotDeletion: StagedStreamSnapshotDeletion =
    await snapshots.stageDeleteStream(stream, clearChildSummaryParentEdges);
  try {
    await deletePersistedStreamLog(stream);
  } catch (error) {
    try {
      await snapshotDeletion.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Transcript and snapshot rollback failed for stream ${stream}`,
      );
    }
    throw error;
  }
  await snapshotDeletion.commit();
}

/** Build one operation-scoped cleaner for callers without a live session. */
function createStandaloneStreamCleanup(): AdjacentStreamCleanup {
  const snapshots = new StreamSnapshotStore();
  return {
    deleteAdjacentStreamState: async (stream) => {
      // This operation intends to remove the stream, so recover an interrupted
      // snapshot deletion as non-live before staging it again. Restrict the
      // repair to this stream; other interrupted operations keep their owner.
      await snapshots.reconcileStagedDeletions(new Set(), new Set([stream]));
      await deletePersistedAdjacentStreamState(stream, snapshots);
    },
  };
}

/** Prefer the live session's lifecycle owner; otherwise use targeted I/O. */
export function resolveAdjacentStreamCleanup(
  liveStreamCleanup: AdjacentStreamCleanup | undefined,
): AdjacentStreamCleanup {
  return liveStreamCleanup ?? createStandaloneStreamCleanup();
}

/**
 * Resolve an execution's stamped stream and delete its adjacent state.
 * Intended for `deleteExecution`/`deleteAllExecutions` `beforeDelete` hooks.
 */
export async function cleanupExecutionAdjacentStreamState(
  executionId: ExecutionId,
  cleanup: AdjacentStreamCleanup,
): Promise<void> {
  try {
    const meta = await getExecutionStore(executionId).readMetaStrict();
    if (!meta?.streamId) return;
    await cleanup.deleteAdjacentStreamState(meta.streamId);
  } catch (error) {
    throw new Error(
      `Execution ${executionId}'s transcript/snapshot sidecars could not be cleaned up: ${toErrorMessage(error)}`,
      { cause: error },
    );
  }
}
