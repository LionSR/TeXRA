/**
 * Handle-based execution registry.
 *
 * Manages ExecutionHandle instances and provides registration, lookup, change
 * notification, and subagent lineage tracking in a single module.
 */

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';
import {
  type ExecutionHandle,
  AgentExecutionHandle,
  ProcessExecutionHandle,
  collectChildSummary,
  interruptActiveChildren as interruptChildren,
} from './ExecutionHandle';
import {
  flushProcessOutput,
  registerProcessOutput,
  unregisterProcessOutput,
} from './ProcessOutputPoller';

export type { ExecutionHandle } from './ExecutionHandle';
export {
  type ExecutionStatusInfo,
  ACTIVE_STATUSES,
  AgentExecutionHandle,
  ProcessExecutionHandle,
} from './ExecutionHandle';

const registry = new Map<string, ExecutionHandle>();
const changeCallbacks = new Map<string, Array<() => void>>();
// Persistent listeners stay attached across notifications (unlike one-shot
// waiters in `changeCallbacks`). Used by the executions subscribe action.
const persistentListeners = new Map<
  string,
  Set<(handle: ExecutionHandle | undefined) => void>
>();

// Notify waiters and refresh UI badges when stream status changes
// (e.g. RUNNING → WAITING). Without this, waitForExecutionChange only resolves
// on progress/kill/untrack, and the background-tasks panel shows stale badges.
StreamStatusService.onDidChange(({ streamId }) => {
  for (const [executionId, handle] of registry) {
    if (
      handle instanceof AgentExecutionHandle &&
      handle.childStreamId === streamId
    ) {
      notifyWaiters(executionId);
      if (handle.parentStreamId !== handle.childStreamId) {
        emitActiveSubagentsUpdate(handle.parentStreamId, handle.runtimeHost);
      }
      break;
    }
  }
});

/** Register an execution handle. */
export function trackExecution(handle: ExecutionHandle): void {
  registry.set(handle.executionId, handle);
  const { runtimeHost } = handle;

  if (handle instanceof AgentExecutionHandle) {
    if (handle.parentStreamId !== handle.childStreamId) {
      emitActiveSubagentsUpdate(handle.parentStreamId, runtimeHost);
      runtimeHost.emit('setParentStream', {
        childStreamId: handle.childStreamId,
        parentStreamId: handle.parentStreamId,
      });
    }
  } else if (handle instanceof ProcessExecutionHandle) {
    registerProcessOutput(handle, runtimeHost);
    emitActiveProcessesUpdate(handle.parentStreamId, runtimeHost);
  }
}

/** Remove an execution handle and notify waiters. */
export function untrackExecution(executionId: string): void {
  const handle = registry.get(executionId);
  registry.delete(executionId);
  notifyWaiters(executionId);
  if (!handle) return;
  const { runtimeHost } = handle;

  if (
    handle instanceof AgentExecutionHandle &&
    handle.parentStreamId !== handle.childStreamId
  ) {
    emitActiveSubagentsUpdate(handle.parentStreamId, runtimeHost);
    return;
  }

  if (handle instanceof ProcessExecutionHandle) {
    // The final read must complete before the badge update, because the
    // badge handler prunes output entries for processes no longer active.
    const finalize = (): void => {
      unregisterProcessOutput(executionId);
      emitActiveProcessesUpdate(handle.parentStreamId, runtimeHost);
    };
    if (handle.outputPaths) {
      void flushProcessOutput(handle, runtimeHost).finally(finalize);
    } else {
      finalize();
    }
  }
}

export function getHandle(executionId: string): ExecutionHandle | undefined {
  return registry.get(executionId);
}

/** Terminate an execution via its handle. Returns true on success. */
export function killExecution(executionId: string): boolean {
  const handle = registry.get(executionId);
  if (!handle) return false;
  const result = handle.terminate();
  // Always notify waiters — even if terminate() returned false (e.g. PID not
  // yet assigned), callers blocking on this execution should be unblocked.
  notifyWaiters(executionId);
  return result;
}

export function getActiveExecutionIds(): string[] {
  return [...registry.keys()];
}

/**
 * Kill only background OS processes (bash, codex) without touching agent
 * stream status. Agent executions are left in RUNNING so restart recovery can
 * restore them to WAITING (resumable) if a flow record exists.
 */
export function killBackgroundProcesses(): void {
  for (const [executionId, handle] of registry) {
    if (handle instanceof ProcessExecutionHandle) {
      killExecution(executionId);
    }
  }
}

export function updateExecutionProgress(
  executionId: string,
  update: { currentRound?: number; totalRounds?: number },
): void {
  const handle = registry.get(executionId);
  if (!handle) return;
  handle.updateProgress(update);
  notifyWaiters(executionId);
}

/**
 * Wait for any change on an execution: status transition, progress update,
 * kill, or completion (untrack). Pass an AbortSignal for timeout cleanup.
 */
export function waitForExecutionChange(
  executionId: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const cb = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      removeChangeCallback(executionId, cb);
      resolve();
    };
    addChangeCallback(executionId, cb);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for any of the given executions to change.
 * Resolves with the execution id that changed first (or '' on abort).
 */
export function waitForAnyExecutionChange(
  executionIds: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let resolved = false;
    const callbacks = new Map<string, () => void>();

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
      for (const [id, cb] of callbacks) {
        removeChangeCallback(id, cb);
      }
    };

    const onAbort = (): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve('');
    };

    for (const id of executionIds) {
      const cb = (): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(id);
      };
      callbacks.set(id, cb);
      addChangeCallback(id, cb);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Interrupt all active subagents of a parent stream. */
export function interruptActiveChildren(parentStreamId: StreamTabId): void {
  interruptChildren(parentStreamId, registry.values());
}

/**
 * Detach all active subagents from a parent, promoting them to top-level.
 * Subagents continue running independently and deliver results via the
 * follow-up queue. Called when stopping an orchestrator without killing
 * children.
 */
export function detachActiveChildren(
  parentStreamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): void {
  for (const handle of registry.values()) {
    if (handle.parentStreamId !== parentStreamId) continue;
    if (
      handle instanceof AgentExecutionHandle &&
      handle.childStreamId !== parentStreamId
    ) {
      handle.detach();
      runtimeHost.emit('setParentStream', {
        childStreamId: handle.childStreamId,
        parentStreamId: null,
      });
    } else if (handle instanceof ProcessExecutionHandle) {
      handle.terminate();
    }
  }
  emitActiveSubagentsUpdate(parentStreamId, runtimeHost);
}

/** Get active subagent and process children for a parent stream. */
export function getActiveChildren(parentStreamId: StreamTabId): {
  subagents: ActiveChildInfo[];
  processes: ActiveChildInfo[];
} {
  return {
    subagents: collectChildSummary(
      parentStreamId,
      registry.values(),
      AgentExecutionHandle,
    ),
    processes: collectChildSummary(
      parentStreamId,
      registry.values(),
      ProcessExecutionHandle,
    ),
  };
}

function emitActiveSubagentsUpdate(
  parentStreamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): void {
  runtimeHost.emit('updateActiveSubagents', {
    parentStreamId,
    children: collectChildSummary(
      parentStreamId,
      registry.values(),
      AgentExecutionHandle,
    ),
  });
}

function emitActiveProcessesUpdate(
  parentStreamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): void {
  runtimeHost.emit('updateActiveProcesses', {
    parentStreamId,
    processes: collectChildSummary(
      parentStreamId,
      registry.values(),
      ProcessExecutionHandle,
    ),
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

function removeChangeCallback(executionId: string, cb: () => void): void {
  const callbacks = changeCallbacks.get(executionId);
  if (!callbacks) return;
  const idx = callbacks.indexOf(cb);
  if (idx !== -1) callbacks.splice(idx, 1);
  if (callbacks.length === 0) changeCallbacks.delete(executionId);
}

function notifyWaiters(executionId: string): void {
  const listeners = persistentListeners.get(executionId);
  const callbacks = changeCallbacks.get(executionId);
  if (!listeners && !callbacks) return;

  // Persistent listeners fire first and stay attached so subscribers keep
  // receiving every transition until they dispose themselves.
  if (listeners) {
    const handle = registry.get(executionId);
    // Iterate a snapshot so a listener disposing itself mid-fire is safe.
    for (const cb of [...listeners]) cb(handle);
  }

  if (callbacks) {
    changeCallbacks.delete(executionId);
    for (const cb of callbacks) cb();
  }

  // Backstop against listener leaks: if the execution is no longer tracked,
  // any still-registered persistent listener is firing into the void.
  if (!registry.has(executionId)) {
    persistentListeners.delete(executionId);
  }
}

/**
 * Add a persistent listener invoked on every change to `executionId` (status
 * transition, progress update, kill, untrack). Returns a disposer.
 *
 * The callback receives the current `ExecutionHandle`, or `undefined` once the
 * execution has been untracked (terminal event).
 */
export function addExecutionListener(
  executionId: string,
  cb: (handle: ExecutionHandle | undefined) => void,
): () => void {
  let set = persistentListeners.get(executionId);
  if (!set) {
    set = new Set();
    persistentListeners.set(executionId, set);
  }
  set.add(cb);
  return () => {
    const s = persistentListeners.get(executionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) persistentListeners.delete(executionId);
  };
}
