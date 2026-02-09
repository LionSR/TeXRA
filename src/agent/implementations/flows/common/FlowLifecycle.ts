/**
 * Shared flow lifecycle helper for both reflection and tool-use flows.
 *
 * Owns the common boilerplate:
 * - Register/unregister interruptible
 * - Acquire execution KV store and read persisted flow record
 * - Cleanup: retry coordinator clear + interruptible unregistration
 *
 * Flow-specific logic (resume parsing, node wiring, cleanup conditions)
 * stays in the caller via the `execute` callback.
 */

import {
  END_GROUP_STATUS,
  type EndGroupStatus,
  type StreamTabId,
  type ExecutionId,
} from '@shared/schemas';
import {
  getExecutionStore,
  type ExecutionKVStore,
} from '@agent/storage/ExecutionKVStore';
import {
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import type { FlowRecord } from '@agent/node/persisted-flow';

/** Context provided to the execute callback. */
export interface FlowLifecycleContext {
  kv: ExecutionKVStore;
  flowRecord: FlowRecord | null;
}

/** Options for withFlowLifecycle. */
export interface FlowLifecycleOptions {
  streamId: StreamTabId;
  executionId: ExecutionId;
  interruptible: IInterruptible;
  /** Called after registration, before execute (e.g. for ToolUseFlowContext setup). */
  onRegistered?: () => void;
}

/**
 * Run a flow with standardized lifecycle management.
 *
 * Handles:
 * 1. Register interruptible for the stream
 * 2. Open KV store and read any persisted flow record
 * 3. Call `execute(ctx)` — caller does resume parsing, node wiring, flow.run()
 * 4. In finally: clear retry requests, unregister interruptible
 *
 * The execute callback receives the KV store and flow record, and must
 * return an EndGroupStatus. Flow record cleanup (delete vs preserve)
 * is the caller's responsibility inside the execute callback.
 */
export async function withFlowLifecycle<T>(
  options: FlowLifecycleOptions,
  execute: (ctx: FlowLifecycleContext) => Promise<T>,
): Promise<T> {
  const { streamId, executionId, interruptible, onRegistered } = options;

  registerInterruptible(streamId, interruptible);
  onRegistered?.();

  const kv: ExecutionKVStore = getExecutionStore(executionId);
  let flowRecord: FlowRecord | null = null;
  try {
    flowRecord =
      (await kv.read<FlowRecord>(`flow:${executionId}`)) ?? null;
  } catch {
    // Resume parse failures are handled by callers — start fresh
    flowRecord = null;
  }

  try {
    return await execute({ kv, flowRecord });
  } finally {
    retryCoordinator.clearRequest(streamId);
    unregisterInterruptible(streamId);
  }
}

/**
 * Delete a flow record from the KV store (best-effort, ignores errors).
 * Shared by both flow runners for cleanup after completion.
 */
export async function deleteFlowRecord(
  executionId: ExecutionId,
): Promise<void> {
  try {
    const kv = getExecutionStore(executionId);
    await kv.delete(`flow:${executionId}`);
  } catch {
    // Ignore cleanup errors
  }
}
