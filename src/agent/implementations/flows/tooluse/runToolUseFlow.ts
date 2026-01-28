/**
 * Entry point for tool-use flow execution.
 *
 * Manages session lifecycle, tool execution cycles, interrupt handling,
 * and state persistence via PersistedFlow.
 */

import {
  EXECUTION_STATUS,
  END_GROUP_STATUS,
  type EndGroupStatus,
  type StreamTabId,
} from '@shared/schemas';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';

import { PersistedFlow, type FlowRecord } from '@agent/node/persisted-flow';
import { executionToEndStatus } from '@common/constants/streamStatus';

import { getDefaultToolRegistry } from '@tools/registry';
import { createToolUseFlow, type ToolUseRunShared } from './ToolUseFlow';
import {
  resolveTools,
  type ToolUseFlowContextInit,
} from './ToolUseFlowContext';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import { migrateSharedState } from './nodes';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';

/** Input for running a tool-use flow. */
export interface RunToolUseFlowInput<C = unknown> extends Omit<
  ToolUseFlowContextInit<C>,
  'resumeSnapshot'
> {
  resumeSnapshot?: ToolUseSessionSnapshot | null;
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

/** Run a tool-use flow. Interrupt registration is handled automatically. */
export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, streamId, executionId, setting, onInterrupt } = input;
  const resumeSnapshot = input.resumeSnapshot ?? null;
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);
  const toolRegistry = input.toolRegistry ?? getDefaultToolRegistry();
  const resolvedTools = resolveTools(setting.tools, toolRegistry, logger);
  const services: ToolUseServices<C> = {
    ...input,
    toolRegistry,
    session: sessionLifecycle,
    resolvedTools,
    snapshot: resumeSnapshot,
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

    const executionStatus = input.checkInterruption()
      ? EXECUTION_STATUS.INTERRUPTED
      : EXECUTION_STATUS.COMPLETED;
    status = executionToEndStatus(executionStatus) as EndGroupStatus;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
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
