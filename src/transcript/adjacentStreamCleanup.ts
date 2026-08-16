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
 * already depends on `@agent/storage` for `getExecutionStore`, and the
 * reverse edge would make that a cycle).
 *
 * Callers with no live session (Settings → History, `texra history delete`)
 * have neither store open, so {@link openStandaloneStreamStores} opens a
 * short-lived pair backed by the same persistent storage root, and
 * {@link cleanupExecutionAdjacentStreamState} resolves the execution's
 * stream and applies the same cleanup.
 *
 * A cleanup path must be more tolerant than the state it repairs: this is
 * best-effort by design. `getExecutionStore(...).readMetaStrict()` fails
 * loudly instead of silently treating malformed metadata as "nothing to
 * clean up" (which would recreate the exact orphan this module exists to
 * prevent), but nothing in {@link cleanupExecutionAdjacentStreamState}
 * propagates — a stream this store can't resolve, or a transcript store that
 * fails to open at all (e.g. one corrupt, unrelated persisted log), must not
 * block deleting the requested execution's own directory. `deleteExecution`
 * removed that directory unconditionally before this module existed; a
 * failure to also clean up its sidecars is strictly better reported loudly
 * and left for a later pass than treated as a reason to keep the execution.
 */
import { getExecutionStore } from '@agent/storage';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';
import type { StagedStreamSnapshotDeletion } from './StagedDeletionCoordinator';

const log = createLog('AdjacentStreamCleanup');

export interface AdjacentStreamStores {
  readonly streamLogs: StreamLogStore;
  readonly snapshots: StreamSnapshotStore;
}

/**
 * Detach every child stream discovered under the deleted parent by clearing
 * its persisted `parentStreamId`. A live session instead routes this through
 * `SessionEventHub` (`createSessionStores`'s `onChildrenDetached`), which
 * also updates the session's in-memory execution registry and skips a
 * still-active child; this module has no session to route through and no
 * execution registry to consult, so it writes the persisted edge directly
 * for every discovered child. `deleteExecution`'s inactive-lease guard
 * already guarantees the parent itself is not active by the time this runs;
 * an independently-active child keeps running unaffected — only its
 * persisted parent pointer (now genuinely dangling) is cleared.
 */
function detachChildren(
  stores: AdjacentStreamStores,
  children: readonly StreamTabId[],
): void {
  for (const child of children) {
    stores.snapshots.setParentStream(child, null);
  }
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
    await stores.snapshots.stageDeleteStream(stream, (children) =>
      detachChildren(stores, children),
    );
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

  await snapshotDeletion.commit();
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
async function openStandaloneStreamStores(): Promise<AdjacentStreamStores> {
  return {
    streamLogs: await StreamLogStore.open(),
    snapshots: new StreamSnapshotStore(),
  };
}

/**
 * Resolve the stores a caller should clean up through: a host-provided live
 * session's stores when usable, otherwise a standalone pair.
 *
 * A live `StreamLogStore` can be in `ephemeral` mode — a host degrades to it
 * when its persistent transcript directory failed to open at startup
 * (`StreamLogStore.openOrEphemeral`), and deliberately never touches disk
 * again for the rest of that process's life. `StreamLogStore.delete()`
 * silently no-ops its on-disk removal in that mode (by design — it has
 * nothing trustworthy to reconcile against), so reusing an ephemeral live
 * store here would commit the snapshot deletion and let the execution
 * directory go while the transcript log sidecar and its index entry are
 * never actually removed — recreating the exact orphan this module exists
 * to prevent, silently. Skip it and fall through to a real, targeted
 * persistent open instead.
 *
 * A store that fails to open (e.g. one corrupt, unrelated persisted stream)
 * must not block deleting the requested execution — warn once and return
 * `undefined` so the caller proceeds with no adjacent-state cleanup for this
 * call.
 */
export async function resolveAdjacentStreamStores(
  liveStreamStores: AdjacentStreamStores | undefined,
): Promise<AdjacentStreamStores | undefined> {
  if (liveStreamStores && liveStreamStores.streamLogs.mode.kind !== 'ephemeral') {
    return liveStreamStores;
  }
  try {
    return await openStandaloneStreamStores();
  } catch (error) {
    log.warn(
      `Could not open the transcript store for history cleanup; deleted executions may leave orphaned sidecars: ${toErrorMessage(error)}`,
      { data: error },
    );
    return undefined;
  }
}

/**
 * Delete a completed execution's adjacent stream state, if it has one.
 * Intended as a `deleteExecution`/`deleteAllExecutions` `beforeDelete` hook
 * for callers that key off `ExecutionId` rather than `StreamTabId` — e.g.
 * Settings → History and `texra history delete`, which otherwise remove only
 * the execution directory and leave its transcript/snapshot sidecars
 * orphaned on disk forever (the startup orphan sweep does not catch them:
 * their stream stays listed in the persistent transcript index).
 *
 * Never throws — see the module doc for why a cleanup failure must not block
 * the execution-directory deletion it's attached to.
 */
export async function cleanupExecutionAdjacentStreamState(
  executionId: ExecutionId,
  stores: AdjacentStreamStores,
): Promise<void> {
  try {
    const meta = await getExecutionStore(executionId).readMetaStrict();
    if (!meta?.streamId) return;
    await deleteAdjacentStreamState(meta.streamId, stores);
  } catch (error) {
    log.warn(
      `Execution ${executionId} was deleted, but its transcript/snapshot sidecars could not be cleaned up: ${toErrorMessage(error)}`,
      { data: error },
    );
  }
}
