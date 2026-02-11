/**
 * Lightweight registry mapping executionId → streamId for active executions.
 *
 * Used by the runs tool to look up current stream status for an execution.
 * Entries are added when an execution starts and removed when it completes.
 */

import type { StreamTabId } from '@shared/schemas';

interface ExecutionEntry {
  streamId: StreamTabId;
  startedAt: number;
}

const registry = new Map<string, ExecutionEntry>();

/** Track an active execution. */
export function trackExecution(
  executionId: string,
  streamId: StreamTabId,
): void {
  registry.set(executionId, { streamId, startedAt: Date.now() });
}

/** Remove a completed execution. */
export function untrackExecution(executionId: string): void {
  registry.delete(executionId);
}

/** Get the stream ID for an active execution (undefined if not running). */
export function getStreamIdForExecution(
  executionId: string,
): StreamTabId | undefined {
  return registry.get(executionId)?.streamId;
}

/** Get the start timestamp (ms) for an active execution. */
export function getExecutionStartedAt(
  executionId: string,
): number | undefined {
  return registry.get(executionId)?.startedAt;
}
