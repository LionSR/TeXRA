/**
 * Deleting an execution and deleting its stream's adjacent transcript +
 * snapshot sidecars (`streamLogs/{stream}.json`, `streamData/{stream}/*`) are
 * two different storage domains with no shared writer unless a caller wires
 * them together explicitly — `deleteExecution`'s `beforeDelete` hook exists
 * for exactly that. `SessionStores` (`@agent/storage`) wires it for the
 * Progress rail, which already owns a live `StreamLogStore`/
 * `StreamSnapshotStore` pair; its own copy of the rollback-safe delete stays
 * separate rather than importing this module, since `@agent/storage`'s
 * barrel must not gain a runtime dependency on `@transcript` (this module
 * already depends on `@agent/storage` for `resolveStreamForExecution`, and
 * the reverse edge would make that a cycle).
 *
 * Callers with no live session (Settings → History, `texra history delete`)
 * have neither store open, so {@link openStandaloneStreamStores} opens a
 * short-lived pair backed by the same persistent storage root, and
 * {@link cleanupExecutionAdjacentStreamState} resolves the execution's
 * stream and applies the same cleanup.
 */
import { createLog } from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { resolveStreamForExecution } from './completedRunArchive';
import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StagedStreamSnapshotDeletion } from './StagedDeletionCoordinator';

const log = createLog('AdjacentStreamCleanup');

export interface AdjacentStreamStores {
  readonly streamLogs: StreamLogStore;
  readonly snapshots: StreamSnapshotStore;
}

/**
 * Delete a stream's transcript log and snapshot sidecars as one unit, rolling
 * the snapshot side back if the transcript delete fails so neither is left
 * half-deleted.
 */
async function deleteAdjacentStreamState(
  stream: StreamTabId,
  stores: AdjacentStreamStores,
): Promise<void> {
  const snapshotDeletion: StagedStreamSnapshotDeletion =
    await stores.snapshots.stageDeleteStream(stream);
  try {
    await stores.streamLogs.delete(stream);
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

  try {
    await snapshotDeletion.commit();
  } catch (error) {
    log.warn(
      `Stream ${stream} was deleted, but auxiliary cleanup was incomplete: ${toErrorMessage(error)}`,
      { data: error },
    );
  }
}

/**
 * Open a transcript/snapshot store pair backed by the persistent storage
 * root, for a caller with no live `SessionHandle` to reuse. Safe to open
 * alongside a host's own live stores: the persistent storage root already
 * tolerates concurrent readers/writers across independent CLI, desktop, and
 * extension processes (see `@agent/storage/executionListing`), so a second
 * in-process store pair is no different in kind. Callers should open one
 * pair per operation (not per execution) and let it be garbage-collected
 * when done.
 */
export async function openStandaloneStreamStores(): Promise<AdjacentStreamStores> {
  return {
    streamLogs: await StreamLogStore.open(),
    snapshots: new StreamSnapshotStore(),
  };
}

/**
 * Delete a completed execution's adjacent stream state, if it has one.
 * Intended as a `deleteExecution`/`deleteAllExecutions` `beforeDelete` hook
 * for callers that key off `ExecutionId` rather than `StreamTabId` — e.g.
 * Settings → History and `texra history delete`, which otherwise remove only
 * the execution directory and leave its transcript/snapshot sidecars
 * orphaned on disk forever (the startup orphan sweep does not catch them:
 * their stream stays listed in the persistent transcript index).
 */
export async function cleanupExecutionAdjacentStreamState(
  executionId: ExecutionId,
  stores: AdjacentStreamStores,
): Promise<void> {
  const resolution = await resolveStreamForExecution(executionId);
  if ('reason' in resolution) return;
  await deleteAdjacentStreamState(resolution.streamId, stores);
}
