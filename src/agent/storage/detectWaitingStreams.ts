/**
 * Detect waiting streams from persisted flow data.
 *
 * Provides lazy detection of persisted tool-use flows that were interrupted
 * mid-session. These streams can be resumed when the user sends a follow-up.
 */

import type { FlowRecord } from '@agent/node/persisted-flow';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

import { getExecutionStore } from './ExecutionKVStore';

/**
 * Check if a single stream has a valid, resumable flow record.
 *
 * Used for lazy detection when a user sends a follow-up to a stream
 * that wasn't detected at startup (or when startup detection is skipped).
 *
 * Note: We read and validate the record rather than just checking existence,
 * because a corrupted/truncated record (e.g., from a crash during write)
 * would cause resume to fail, leaving the stream stuck in WAITING state.
 *
 * @returns true if a valid flow record exists (session can be resumed)
 */
export async function hasPersistedFlowRecord(
  executionId: ExecutionId,
): Promise<boolean> {
  try {
    const kv = getExecutionStore(executionId);
    const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);
    // Use truthy check to match resume logic in SessionResumeRetrieval.ts
    // This rejects null, undefined, and empty objects consistently
    return !!flowRecord?.shared;
  } catch {
    return false;
  }
}

/**
 * Detect streams that have persisted flow state and should be marked as WAITING.
 *
 * A stream is considered "waiting" if it has a persisted flow record, which only
 * happens when VS Code reloads mid-execution (the finally block in runToolUseFlow
 * deletes the record on normal completion).
 *
 * @param executionIdMap - Map of streamTabId to executionId from ProgressViewState
 * @returns Set of streamIds that have persisted flows (should be marked WAITING)
 */
export async function detectWaitingStreams(
  executionIdMap: ReadonlyMap<StreamTabId, ExecutionId>,
): Promise<Set<StreamTabId>> {
  const waitingStreams = new Set<StreamTabId>();

  for (const [streamId, executionId] of executionIdMap) {
    if (await hasPersistedFlowRecord(executionId)) {
      waitingStreams.add(streamId);
    }
  }

  return waitingStreams;
}
