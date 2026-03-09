/**
 * Handle-based execution registry.
 *
 * Manages ExecutionHandle instances, providing registration, lookup,
 * change notification, and subagent lineage tracking in a single module.
 */

import * as fs from 'fs';

import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';
import {
  type ExecutionHandle,
  AgentExecutionHandle,
  ProcessExecutionHandle,
  emitActiveSubagentsUpdate,
  emitActiveProcessesUpdate,
  interruptActiveChildren as interruptActiveChildrenImpl,
} from './ExecutionHandle';

export type { ExecutionHandle } from './ExecutionHandle';
export {
  type ExecutionStatusInfo,
  ACTIVE_STATUSES,
  AgentExecutionHandle,
  ProcessExecutionHandle,
} from './ExecutionHandle';

const registry = new Map<string, ExecutionHandle>();
const changeCallbacks = new Map<string, Array<() => void>>();

// Notify waiters when stream status changes (e.g. RUNNING → WAITING).
// Without this, waitForExecutionChange only resolves on progress/kill/untrack.
bus.on('updateStreamStatus', ({ streamId }) => {
  for (const [executionId, handle] of registry) {
    if (
      handle instanceof AgentExecutionHandle &&
      handle.childStreamId === streamId
    ) {
      notifyWaiters(executionId);
      break;
    }
  }
});

// ============================================================================
// Core registry operations
// ============================================================================

/** Register an execution handle. */
export function trackExecution(handle: ExecutionHandle): void {
  registry.set(handle.executionId, handle);

  // Emit subagent UI update and parent linkage only for actual subagents
  // (where parentStreamId differs from childStreamId)
  if (handle instanceof AgentExecutionHandle) {
    if (handle.parentStreamId !== handle.childStreamId) {
      emitActiveSubagentsUpdate(handle.parentStreamId, registry.values());
      bus.emit('setParentStream', {
        childStreamId: handle.childStreamId,
        parentStreamId: handle.parentStreamId,
      });
    }
  }

  // Emit process badge update for background bash processes
  if (handle instanceof ProcessExecutionHandle) {
    emitActiveProcessesUpdate(handle.parentStreamId, registry.values());
    reconcileOutputPoller();
  }
}

/** Remove an execution handle and notify waiters. */
export function untrackExecution(executionId: string): void {
  const handle = registry.get(executionId);
  registry.delete(executionId);
  notifyWaiters(executionId);

  // Emit subagent UI update on removal (only for actual subagents)
  if (
    handle instanceof AgentExecutionHandle &&
    handle.parentStreamId !== handle.childStreamId
  ) {
    emitActiveSubagentsUpdate(handle.parentStreamId, registry.values());
  }

  // Emit process badge update on removal and flush final output
  if (handle instanceof ProcessExecutionHandle) {
    // Final poll to capture any remaining output, then clean up offset
    if (handle.outputPaths) {
      void readIncremental(
        executionId,
        handle.parentStreamId,
        handle.outputPaths.stdout,
        handle.outputPaths.stderr,
      ).finally(() => outputOffsets.delete(executionId));
    } else {
      outputOffsets.delete(executionId);
    }
    emitActiveProcessesUpdate(handle.parentStreamId, registry.values());
    reconcileOutputPoller();
  }
}

/** Get a handle by execution ID. */
export function getHandle(executionId: string): ExecutionHandle | undefined {
  return registry.get(executionId);
}

/** Terminate an execution via its handle. Returns true if successful. */
export function killExecution(executionId: string): boolean {
  const handle = registry.get(executionId);
  if (!handle) return false;
  const result = handle.terminate();
  // Always notify waiters — even if terminate() returned false (e.g. PID not
  // yet assigned), callers blocking on this execution should be unblocked.
  notifyWaiters(executionId);
  return result;
}

/** All currently tracked (active) execution IDs. */
export function getActiveExecutionIds(): string[] {
  return [...registry.keys()];
}

/** Delegate progress update to the handle. */
export function updateExecutionProgress(
  executionId: string,
  update: { currentRound?: number; totalRounds?: number },
): void {
  const handle = registry.get(executionId);
  if (!handle) return;
  handle.updateProgress(update);
  notifyWaiters(executionId);
}

// ============================================================================
// Blocking wait
// ============================================================================

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
 * Resolves with the execution ID that changed first (or '' on abort).
 * Pass an AbortSignal to clean up callbacks if the caller times out.
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

// ============================================================================
// Subagent lineage
// ============================================================================

/**
 * Interrupt all active subagents of a parent stream.
 * Called before interrupting the parent so subagents stop
 * promptly instead of running to completion.
 */
export function interruptActiveChildren(parentStreamId: StreamTabId): void {
  interruptActiveChildrenImpl(parentStreamId, registry.values());
}

// ============================================================================
// Process output polling
// ============================================================================

/** Interval at which temp files are read and pushed to the progress UI. */
const OUTPUT_POLL_INTERVAL_MS = 500;

/** Tracks byte offsets already sent per executionId per stream. */
const outputOffsets = new Map<
  string,
  { stdout: number; stderr: number }
>();

let outputPollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;

/** Check whether any tracked execution is a process handle. */
function hasActiveProcesses(): boolean {
  for (const h of registry.values()) {
    if (h instanceof ProcessExecutionHandle) return true;
  }
  return false;
}

/** Start polling if there are active process handles; stop if none remain. */
function reconcileOutputPoller(): void {
  const active = hasActiveProcesses();
  if (active && !outputPollTimer) {
    schedulePoll();
  } else if (!active && outputPollTimer) {
    clearTimeout(outputPollTimer);
    outputPollTimer = null;
  }
}

/** Schedule the next poll cycle (serialized — next poll waits for current to finish). */
function schedulePoll(): void {
  outputPollTimer = setTimeout(async () => {
    // Clear stale timer ID so reconcileOutputPoller sees !outputPollTimer
    outputPollTimer = null;
    if (pollInFlight) {
      schedulePoll();
      return;
    }
    pollInFlight = true;
    try {
      await pollProcessOutputs();
    } finally {
      pollInFlight = false;
      reconcileOutputPoller();
    }
  }, OUTPUT_POLL_INTERVAL_MS);
}

/** Read incremental output from temp files and emit to progress UI. */
async function pollProcessOutputs(): Promise<void> {
  const reads: Promise<void>[] = [];
  for (const handle of registry.values()) {
    if (!(handle instanceof ProcessExecutionHandle)) continue;
    if (!handle.outputPaths) continue;

    reads.push(
      readIncremental(
        handle.executionId,
        handle.parentStreamId,
        handle.outputPaths.stdout,
        handle.outputPaths.stderr,
      ),
    );
  }
  await Promise.all(reads);
}

/** Read only the new bytes from a file starting at byteOffset. */
async function readTail(
  path: string,
  byteOffset: number,
): Promise<{ text: string; newOffset: number }> {
  const fh = await fs.promises.open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= byteOffset) return { text: '', newOffset: byteOffset };
    const buf = Buffer.alloc(size - byteOffset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, byteOffset);
    return { text: buf.toString('utf-8', 0, bytesRead), newOffset: byteOffset + bytesRead };
  } finally {
    await fh.close();
  }
}

async function readIncremental(
  executionId: string,
  parentStreamId: StreamTabId,
  stdoutPath: string,
  stderrPath: string,
): Promise<void> {
  try {
    const prev = outputOffsets.get(executionId) ?? { stdout: 0, stderr: 0 };
    const [out, err] = await Promise.all([
      readTail(stdoutPath, prev.stdout).catch(() => ({ text: '', newOffset: prev.stdout })),
      readTail(stderrPath, prev.stderr).catch(() => ({ text: '', newOffset: prev.stderr })),
    ]);
    if (!out.text && !err.text) return;

    outputOffsets.set(executionId, {
      stdout: out.newOffset,
      stderr: err.newOffset,
    });

    bus.emit('updateProcessOutput', {
      parentStreamId,
      executionId,
      output: out.text + err.text,
    });
  } catch {
    // File may have been deleted between check and read — ignore
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

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
  const callbacks = changeCallbacks.get(executionId);
  if (!callbacks) return;
  changeCallbacks.delete(executionId);
  for (const cb of callbacks) cb();
}
