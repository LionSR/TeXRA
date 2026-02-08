/**
 * Entry point for tool-use flow execution.
 *
 * Manages session lifecycle, tool execution cycles, interrupt handling,
 * and state persistence via PersistedFlow.
 */

import {
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  type EndGroupStatus,
} from '@shared/schemas';
import { executionToEndStatus } from '@common/constants/streamStatus';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';

import { PersistedFlow, type FlowRecord } from '@agent/node/persisted-flow';

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { getDefaultToolRegistry } from '@tools/registry';
import { getToolUseMemoryEnabled } from '@utils/config/constants';
import { Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { ToolUseCycleNode } from './nodes/ToolUseCycleNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import { migrateSharedState, type ToolUseRunShared } from './nodes/types';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
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

/**
 * Runtime context for tool-use flow execution (implements IInterruptible).
 * The `session` field provides direct access for follow-up operations,
 * avoiding the need to traverse through services for common operations.
 */
export interface ToolUseFlowContext<C = unknown> {
  services: ToolUseServices<C>;
  /** Direct accessor for follow-up operations (also available via services.session). */
  session: ToolUseSessionLifecycle;
  interrupt(): void;
  dispose(): void;
}

/** Setup callback invoked after context creation, before execution starts. */
export type ToolUseFlowSetupCallback = (
  context: ToolUseFlowContext<unknown>,
) => void;

/** Resolve tool definitions from agent settings, validating against registry. */
function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry,
  logger: { warn: (msg: string) => void },
): ToolDefinition[] {
  const toolConfigs = Array.isArray(tools) ? tools : [];
  const resolved = toolConfigs
    .map((config) => (typeof config === 'string' ? { name: config } : config))
    .filter((def) => {
      if (!registry.has(def.name)) {
        logger.warn(`Tool "${def.name}" not found in registry`);
        return false;
      }
      return true;
    });
  if (getToolUseMemoryEnabled() && !resolved.some((d) => d.name === 'memory')) {
    const memoryTool = registry.get('memory');
    if (memoryTool) {
      resolved.push(memoryTool.definition);
    } else {
      logger.warn('Memory tool not found in registry');
    }
  }
  return resolved;
}

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
    toolRegistry: registry,
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

  // Shared state is declared outside try block for access in finally (cleanup decision based on userCancelledRetry)
  const shared: ToolUseRunShared = {
    conversation: [],
    shouldSkipCycle: false,
    stateSlices: null,
  };

  try {
    registerInterruptible(streamId, flowContext);
    onSetup?.(flowContext);

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

    // Create flow nodes and wire transitions inline
    const prepareNode = new ToolUsePrepareNode<C>();
    const cycleNode = new ToolUseCycleNode<C>();
    const waitNode = new ToolUseWaitNode<C>();
    prepareNode.next(cycleNode);
    cycleNode.next(waitNode);
    waitNode.on(FlowTransition.CONTINUE, cycleNode);
    const startNode = prepareNode;
    const pf = new PersistedFlow<
      ToolUseRunShared,
      Record<string, unknown>,
      ToolUseServices<C>
    >(startNode, kv);
    pf.setServices(flowContext.services);
    await pf.run(shared);

    const execStatus = input.checkInterruption()
      ? EXECUTION_STATUS.INTERRUPTED
      : EXECUTION_STATUS.COMPLETED;
    status = executionToEndStatus(execStatus) as EndGroupStatus;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Preserve flow record if user cancelled retry (for resume), otherwise delete
    // Use the local shared object directly - it's updated in place during pf.run()
    if (shared.userCancelledRetry) {
      logger.debug('Flow record preserved for resume after retry cancellation');
    } else {
      try {
        const kv = getExecutionStore(executionId);
        await kv.delete(`flow:${executionId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    flowContext.dispose();
    unregisterInterruptible(streamId);
  }

  return { status };
}
