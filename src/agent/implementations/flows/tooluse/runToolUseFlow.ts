/**
 * Entry point for tool-use flow execution.
 *
 * Flat flow graph — cycle nodes wired directly, no inner Flow nesting.
 * CycleSetupNode/CycleTeardownNode bridge snapshot ↔ live state at cycle boundaries.
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

import type { AgentRunStateSnapshot } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import {
  ToolUsePrepNode,
  ToolUseCallNode,
  ToolUseProcessNode,
  ToolUseDispatchNode,
} from '@agent/core/flows/ToolUseCycleFlow';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { getDefaultToolRegistry } from '@tools/registry';
import { getToolUseMemoryEnabled } from '@utils/config/constants';

import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { CycleSetupNode } from './nodes/CycleSetupNode';
import { CycleTeardownNode } from './nodes/CycleTeardownNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import { migrateSharedState, type ToolUseRunShared } from './nodes/types';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';

// ---- Public types -----------------------------------------------------------

export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  onFollowUpConsumed?: () => void;
  isSubagent?: boolean;
}

export interface RunToolUseFlowResult {
  status: EndGroupStatus;
  lastResponse?: string;
}

export interface ToolUseFlowContext {
  readonly session: ToolUseSessionLifecycle;
  readonly modelHandler: ToolUseServices['modelHandler'];
  interrupt(): void;
}

export type ToolUseFlowSetupCallback = (context: ToolUseFlowContext) => void;

// ---- Flat services type (extends ToolUseServices with cycle-level fields) ---

/** Services for the flat tool-use flow. Satisfies both ToolUseServices and ToolUseCycleServices. */
export interface FlatToolUseServices<C = unknown> extends ToolUseServices<C> {
  readonly client: C;
  refreshClient(): Promise<void>;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  readonly modelName: string;
  readonly agentName: string;
  /** Update mutable run/workspace refs for the next cycle. */
  updateCycleState(run: AgentRunStateSnapshot, workspace: AgentWorkspaceState): void;
}

// ---- Tool resolution --------------------------------------------------------

const PROPOSAL_TOOLS = new Set(['propose_workflow', 'propose_agent']);

function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry,
  logger: { warn: (msg: string) => void },
  options?: { isSubagent?: boolean },
): ToolDefinition[] {
  const toolConfigs = Array.isArray(tools) ? tools : [];
  const resolved = toolConfigs
    .map((config) => (typeof config === 'string' ? { name: config } : config))
    .filter((def) => {
      if (options?.isSubagent && PROPOSAL_TOOLS.has(def.name)) return false;
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

// ---- Flow runner ------------------------------------------------------------

export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  toolRegistry?: IToolRegistry,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, streamId, executionId, setting, onInterrupt, modelHandler, config } = input;
  const snapshot = input.resumeSnapshot ?? null;
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);
  const registry = toolRegistry ?? getDefaultToolRegistry();
  const resolvedTools = resolveTools(setting.tools, registry, logger, {
    isSubagent: input.isSubagent,
  });

  // Build flat services: ToolUseServices + cycle fields (client, run, workspace via mutable refs)
  const refs = {
    run: null as AgentRunStateSnapshot | null,
    workspace: null as AgentWorkspaceState | null,
    client: await modelHandler.getClient(),
  };
  const services: FlatToolUseServices<C> = {
    ...input,
    setting: { ...setting, tools: resolvedTools } as AgentToolUseSetting,
    session: sessionLifecycle,
    resolvedTools,
    toolRegistry: registry,
    snapshot,
    onRoundFinalized: (input.onRoundFinalized ?? (async () => {})) as RoundFinalizedCallback,
    get client(): C { return refs.client; },
    async refreshClient() { refs.client = await modelHandler.getClient(); },
    get run(): AgentRunStateSnapshot { return refs.run!; },
    get workspace(): AgentWorkspaceState { return refs.workspace!; },
    modelName: config.model,
    agentName: config.agent,
    updateCycleState(run, workspace) { refs.run = run; refs.workspace = workspace; },
  };

  const flowContext: ToolUseFlowContext = {
    session: sessionLifecycle,
    modelHandler: input.modelHandler,
    interrupt(): void {
      onInterrupt?.();
      retryCoordinator.clearRequest(streamId);
      sessionLifecycle.interrupt();
    },
  };

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  const shared: ToolUseRunShared = {
    messages: [],
    shouldSkipCycle: false,
    stateSlices: null,
    shouldStop: false,
    endTurn: false,
    cycleIndex: 0,
    cycleResponseTimeMs: 0,
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

    // Flat graph: Prepare → Setup → Prep → Call → Process → Dispatch → Teardown → Wait
    //                         ↑        ↑                        |C          |C
    //                         |        └────────────────────────┘           |
    //                         └────────────────────────────────────────────┘
    const prepareNode = new ToolUsePrepareNode<C>();
    const setupNode = new CycleSetupNode<C>();
    const teardownNode = new CycleTeardownNode<C>();
    const waitNode = new ToolUseWaitNode<C>();
    const cyclePrepNode = new ToolUsePrepNode<C>();
    const callNode = new ToolUseCallNode<C>();
    const processNode = new ToolUseProcessNode<C>();
    const dispatchNode = new ToolUseDispatchNode<C>();

    prepareNode.next(setupNode);
    setupNode.next(cyclePrepNode);
    setupNode.on(FlowTransition.COMPLETE, teardownNode);
    cyclePrepNode.next(callNode);
    callNode.next(processNode);
    processNode.next(dispatchNode);
    dispatchNode.on(FlowTransition.CONTINUE, cyclePrepNode);
    cyclePrepNode.on(FlowTransition.COMPLETE, teardownNode);
    callNode.on(FlowTransition.COMPLETE, teardownNode);
    processNode.on(FlowTransition.COMPLETE, teardownNode);
    dispatchNode.on(FlowTransition.COMPLETE, teardownNode);
    teardownNode.next(waitNode);
    waitNode.on(FlowTransition.CONTINUE, setupNode);

    const pf = new PersistedFlow<ToolUseRunShared, Record<string, unknown>, FlatToolUseServices<C>>(
      prepareNode, kv,
    );
    pf.setServices(services);
    await pf.run(shared);

    const execStatus = input.checkInterruption()
      ? EXECUTION_STATUS.INTERRUPTED
      : EXECUTION_STATUS.COMPLETED;
    status = executionToEndStatus(execStatus) as EndGroupStatus;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    try { services.workspace?.todos?.clearOnUpdate(); } catch { /* workspace refs may be null */ }

    if (shared.userCancelledRetry) {
      logger.debug('Flow record preserved for resume after retry cancellation');
    } else {
      try {
        const kv = getExecutionStore(executionId);
        await kv.delete(`flow:${executionId}`);
      } catch { /* ignore cleanup errors */ }
    }

    sessionLifecycle.dispose();
    unregisterInterruptible(streamId);
  }

  let lastResponse: string | undefined;
  for (let i = shared.messages.length - 1; i >= 0; i--) {
    const text = input.modelHandler.extractAssistantText(shared.messages[i]);
    if (text !== undefined) {
      lastResponse = text;
      break;
    }
  }

  return { status, lastResponse };
}
