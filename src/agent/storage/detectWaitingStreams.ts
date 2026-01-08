/**
 * Detect waiting streams from persisted flow data.
 *
 * Provides lazy detection of persisted tool-use flows that were interrupted
 * mid-session. These streams can be resumed when the user sends a follow-up.
 */

import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

import { getExecutionStore } from './ExecutionKVStore';

/**
 * Check if a single stream has a persisted flow record.
 *
 * Used for lazy detection when a user sends a follow-up to a stream
 * that wasn't detected at startup (or when startup detection is skipped).
 *
 * @returns true if a persisted flow record exists (session can be resumed)
 */
export async function hasPersistedFlowRecord(
  executionId: ExecutionId,
): Promise<boolean> {
  try {
    const kv = getExecutionStore(executionId);
    return await kv.exists(`flow:${executionId}`);
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
    try {
      const kv = getExecutionStore(executionId);
      // Use exists() instead of read() to avoid loading entire session into memory.
      // The flow record can be large (contains full conversation history).
      // We only need to know if it exists - actual loading happens on resume.
      const hasFlowRecord = await kv.exists(`flow:${executionId}`);

      if (hasFlowRecord) {
        waitingStreams.add(streamId);
      }
    } catch {
      // Ignore errors - stream won't be marked as waiting
    }
  }

  return waitingStreams;
}
