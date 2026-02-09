/**
 * Unified flow runner: interrupt registration, KV store, resume, cleanup.
 */

import { END_GROUP_STATUS, type EndGroupStatus, type StreamTabId, type ExecutionId } from '@shared/schemas';
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
import { type FlowRecord } from '@agent/node/persisted-flow';
import type { AgentLogger } from '@logger/AgentLogger';

export interface FlowRunnerContext {
  streamId: StreamTabId;
  executionId: ExecutionId;
  logger: AgentLogger;
}

export interface ResumeState<S> {
  shared: S | null;
  flowRecord: FlowRecord | null;
  kv: ExecutionKVStore;
}

export interface PersistedFlowRunnerOptions<S> {
  ctx: FlowRunnerContext;
  interruptible: IInterruptible;
  /** Validate persisted shared state. Return parsed state or null. */
  validateResume?: (raw: unknown) => S | null;
  /** Migrate legacy flow record format before validation. */
  migrateResume?: (flowRecord: FlowRecord, kv: ExecutionKVStore) => Promise<FlowRecord | null>;
  /** Create/configure and run the flow. Return the end status. */
  execute: (resume: ResumeState<S>) => Promise<EndGroupStatus>;
  /** Preserve flow record after completion. Default: preserve unless STOPPED. */
  preserveFlowRecord?: boolean | ((status: EndGroupStatus) => boolean);
}

export async function runPersistedFlow<S>(
  options: PersistedFlowRunnerOptions<S>,
): Promise<EndGroupStatus> {
  const { ctx, interruptible, execute } = options;
  const { streamId, executionId } = ctx;

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;

  try {
    registerInterruptible(streamId, interruptible);

    const kv: ExecutionKVStore = getExecutionStore(executionId);

    // Read existing flow record for resume
    let flowRecord: FlowRecord | null = null;
    try {
      flowRecord = (await kv.read<FlowRecord>(`flow:${executionId}`)) ?? null;
    } catch (error) {
      ctx.logger.debug(
        `Resume parse failed, starting fresh: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    // Migrate if needed
    if (flowRecord?.shared && options.migrateResume) {
      flowRecord = await options.migrateResume(flowRecord, kv);
      if (flowRecord === null) {
        ctx.logger.warn('Migration failed, deleting corrupted flow record');
        await kv.delete(`flow:${executionId}`);
      }
    }

    // Validate persisted shared state
    let resumedShared: S | null = null;
    if (flowRecord?.shared && options.validateResume) {
      resumedShared = options.validateResume(flowRecord.shared);
      if (resumedShared === null) {
        ctx.logger.warn('Failed to parse flow record shared state, starting fresh');
        await kv.delete(`flow:${executionId}`);
        flowRecord = null;
      }
    }

    status = await execute({ shared: resumedShared, flowRecord, kv });
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    const shouldPreserve =
      typeof options.preserveFlowRecord === 'function'
        ? options.preserveFlowRecord(status)
        : typeof options.preserveFlowRecord === 'boolean'
          ? options.preserveFlowRecord
          : status !== END_GROUP_STATUS.STOPPED;

    if (!shouldPreserve) {
      try {
        const kv = getExecutionStore(executionId);
        await kv.delete(`flow:${executionId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    retryCoordinator.clearRequest(streamId);
    unregisterInterruptible(streamId);
  }

  return status;
}
