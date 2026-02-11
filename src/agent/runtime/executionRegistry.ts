import type { StreamTabId } from '@shared/schemas';

export interface ExecutionProgress {
  category: 'workflow' | 'toolUse';
  agentName: string;
  currentRound?: number;
  totalRounds?: number;
}

interface ExecutionEntry {
  streamId: StreamTabId;
  startedAt: number;
  progress: ExecutionProgress;
}

const registry = new Map<string, ExecutionEntry>();
const changeCallbacks = new Map<string, Array<() => void>>();

export function trackExecution(
  executionId: string,
  streamId: StreamTabId,
  progress: ExecutionProgress,
): void {
  registry.set(executionId, { streamId, startedAt: Date.now(), progress });
}

export function untrackExecution(executionId: string): void {
  registry.delete(executionId);
  notifyWaiters(executionId);
}

export function getStreamIdForExecution(
  executionId: string,
): StreamTabId | undefined {
  return registry.get(executionId)?.streamId;
}

export function getExecutionStartedAt(executionId: string): number | undefined {
  return registry.get(executionId)?.startedAt;
}

export function getExecutionProgress(
  executionId: string,
): ExecutionProgress | undefined {
  return registry.get(executionId)?.progress;
}

export function updateExecutionProgress(
  executionId: string,
  update: Partial<ExecutionProgress>,
): void {
  const entry = registry.get(executionId);
  if (!entry) return;
  Object.assign(entry.progress, update);
  notifyWaiters(executionId);
}

/** All currently tracked (active) execution IDs. */
export function getActiveExecutionIds(): string[] {
  return [...registry.keys()];
}

/**
 * Wait for a progress update or execution completion.
 * Resolves when `updateExecutionProgress` or `untrackExecution` is called.
 */
export function waitForExecutionChange(executionId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    addChangeCallback(executionId, resolve);
  });
}

/**
 * Wait for any of the given executions to change.
 * Resolves with the execution ID that changed first.
 */
export function waitForAnyExecutionChange(
  executionIds: string[],
): Promise<string> {
  return new Promise<string>((resolve) => {
    let resolved = false;
    for (const id of executionIds) {
      addChangeCallback(id, () => {
        if (resolved) return;
        resolved = true;
        resolve(id);
      });
    }
  });
}

function addChangeCallback(executionId: string, cb: () => void): void {
  let callbacks = changeCallbacks.get(executionId);
  if (!callbacks) {
    callbacks = [];
    changeCallbacks.set(executionId, callbacks);
  }
  callbacks.push(cb);
}

function notifyWaiters(executionId: string): void {
  const callbacks = changeCallbacks.get(executionId);
  if (!callbacks) return;
  changeCallbacks.delete(executionId);
  for (const cb of callbacks) cb();
}
