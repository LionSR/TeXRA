import type { StreamTabId } from '@shared/schemas';

interface ExecutionEntry {
  streamId: StreamTabId;
  startedAt: number;
}

const registry = new Map<string, ExecutionEntry>();

export function trackExecution(
  executionId: string,
  streamId: StreamTabId,
): void {
  registry.set(executionId, { streamId, startedAt: Date.now() });
}

export function untrackExecution(executionId: string): void {
  registry.delete(executionId);
}

export function getStreamIdForExecution(
  executionId: string,
): StreamTabId | undefined {
  return registry.get(executionId)?.streamId;
}

export function getExecutionStartedAt(executionId: string): number | undefined {
  return registry.get(executionId)?.startedAt;
}
