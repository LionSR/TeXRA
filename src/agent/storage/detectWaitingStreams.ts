/**
 * Detect waiting streams from persisted flow data.
 *
 * Provides lazy detection of persisted tool-use flows that were interrupted
 * mid-session. These streams can be resumed when the user sends a follow-up.
 */

import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { filterNotNull } from '@utils/core';
import { deriveResumability } from './resumability';

/**
 * Detect streams that have persisted flow state and should be marked as WAITING.
 *
 * A stream is considered "waiting" if it has a persisted flow record, which only
 * happens when VS Code reloads mid-execution (the finally block in runToolUseFlow
 * deletes the record on normal completion).
 *
 * @returns Set of streamIds that have persisted flows (should be marked WAITING)
 */
export async function detectWaitingStreams(
  executionIdMap: ReadonlyMap<StreamTabId, ExecutionId>,
): Promise<Set<StreamTabId>> {
  const checks = Array.from(executionIdMap, async ([streamId, executionId]) =>
    (await deriveResumability(executionId)).resumable ? streamId : null,
  );
  const results = await Promise.all(checks);
  return new Set(results.filter(filterNotNull));
}
