/**
 * Detect waiting streams from persisted flow data.
 *
 * On extension startup, scans ExecutionKVStore for persisted tool-use flows
 * that were interrupted mid-session. These streams should be marked as WAITING
 * so users can send follow-ups and resume them.
 */

import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import type { FlowRecord } from '@agent/node/persisted-flow';

import { getExecutionStore } from './ExecutionKVStore';

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
      const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);

      // If a flow record exists, this stream was mid-session and should be WAITING
      if (flowRecord?.shared) {
        waitingStreams.add(streamId);
      }
    } catch {
      // Ignore errors - stream won't be marked as waiting
    }
  }

  return waitingStreams;
}
