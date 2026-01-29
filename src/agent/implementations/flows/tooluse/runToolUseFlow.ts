/**
 * Entry point for tool-use flow execution.
 *
 * Manages session lifecycle, tool execution cycles, interrupt handling,
 * and state persistence via PersistedFlow.
 */

import { END_GROUP_STATUS, type EndGroupStatus } from '@shared/schemas';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';

import { PersistedFlow, type FlowRecord } from '@agent/node/persisted-flow';

import { getDefaultToolRegistry } from '@tools/registry';
import {
  toEndStatus,
  getExecutionStatus,
  ERROR_STATUS,
} from '../common/FlowLifecycle';
import { createToolUseFlow, type ToolUseRunShared } from './ToolUseFlow';
import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { resolveTools } from './ToolUseFlowContext';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import { migrateSharedState } from './nodes';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';

/**
 * Input for running a tool-use flow.
 * Follows same pattern as RunReflectionFlowInput: extends BaseFlowContextInit
 * and adds flow-specific fields. toolRegistry is a separate parameter.
 */
export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  onFollowUpConsumed?: () => void;
}

/** Result from running a tool-use flow. */
export interface RunToolUseFlowResult {
  status: EndGroupStatus;
}

/** Runtime context for tool-use flow execution. */
export interface ToolUseFlowContext<C = unknown> {
  services: ToolUseServices<C>;
  session: ToolUseSessionLifecycle;
  interrupt(): void;
  dispose(): void;
}

/** Setup callback invoked after context creation, before execution starts. */
export type ToolUseFlowSetupCallback = (
  context: ToolUseFlowContext<unknown>,
) => void;

/**
 * Run a tool-use flow. Interrupt registration is handled automatically.
 * @param input - Flow input (extends BaseFlowContextInit with tool-use fields)
 * @param toolRegistry - Optional tool registry (defaults to global registry)
 * @param onSetup - Optional callback invoked after context creation
 */
export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  toolRegistry?: IToolRegistry,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, streamId, executionId, setting, onInterrupt } = input;
  const snapshot = input.resumeSnapshot ?? null;
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);
  const registry = toolRegistry ?? getDefaultToolRegistry();
  const resolvedTools = resolveTools(setting.tools, registry, logger);

  // Build services: spread input + add computed fields (matches reflection flow pattern)
  const services: ToolUseServices<C> = {
    ...input,
    session: sessionLifecycle,
    resolvedTools,
    snapshot,
    getUsageRecorder: input.getUsageRecorder ?? (() => async () => {}),
  };

  const flowContext: ToolUseFlowContext<C> = {
    services,
    session: sessionLifecycle,
    interrupt(): void {
      onInterrupt?.();
      retryCoordinator.clearRequest(streamId);
      sessionLifecycle.interrupt();
    },
    dispose(): void {
      sessionLifecycle.dispose();
    },
  };

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;

  try {
    registerInterruptible(streamId, flowContext);
    onSetup?.(flowContext as ToolUseFlowContext<unknown>);

    const kv: ExecutionKVStore = getExecutionStore(executionId);
    let flowRecord: FlowRecord | null = null;
    try {
      flowRecord = (await kv.read<FlowRecord>(`flow:${executionId}`)) ?? null;
    } catch (error) {
      logger.debug(
        `Resume parse failed, starting fresh: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    if (flowRecord?.shared) {
      logger.debug('Resuming tool-use flow from persistence');
      // Migrate legacy nested format to flat format if needed
      const migrationResult = migrateSharedState(flowRecord.shared);
      if (migrationResult === null) {
        logger.warn('Failed to parse flow record shared state, starting fresh');
        await kv.delete(`flow:${executionId}`);
        flowRecord = null;
      } else if (migrationResult.migrated) {
        logger.debug('Migrated legacy shared state to flat format');
        flowRecord.shared = migrationResult.data;
        await kv.write(`flow:${executionId}`, flowRecord);
      }
    }

    const shared: ToolUseRunShared = {
      conversation: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };

    const startNode = createToolUseFlow<C>().start;
    const pf = new PersistedFlow<
      ToolUseRunShared,
      Record<string, unknown>,
      ToolUseServices<C>
    >(startNode, kv);
    pf.setServices(flowContext.services);
    await pf.run(shared);

    status = toEndStatus(getExecutionStatus(input.checkInterruption));
  } catch (error) {
    status = ERROR_STATUS;
    throw error;
  } finally {
    // Preserve flow record if user cancelled retry (for resume), otherwise delete
    try {
      const kv = getExecutionStore(executionId);
      const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);
      const migrationResult = flowRecord?.shared
        ? migrateSharedState(flowRecord.shared)
        : null;
      const userCancelledRetry =
        migrationResult?.data?.userCancelledRetry === true;

      if (userCancelledRetry) {
        logger.debug(
          'Flow record preserved for resume after retry cancellation',
        );
      } else {
        await kv.delete(`flow:${executionId}`);
      }
    } catch {
      // Ignore cleanup errors
    }

    flowContext.dispose();
    unregisterInterruptible(streamId);
  }

  return { status };
}
