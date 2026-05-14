import { getExecutionStore } from '@agent/storage';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import {
  clearPlanApprovalForStream,
  clearRetryRequest,
} from '@agent/runtime/runCoordinators';
import {
  PersistedFlow,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { getGlobalState } from '@agent/core/stateStore';
import { readNestedDelegationConfig } from '@agent/runtime/delegationPolicy';
import { GlobalStateKey } from '@common/state/stateKeys';
import { executionToEndStatus } from '@common/constants/streamStatus';
import type { ToolDefinition } from '@model';
import {
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  type EndGroupStatus,
} from '@shared/schemas';
import type { SubagentProgressUpdate } from '@shared/schemas';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { evaluateDelegationGate } from '@shared/constants/delegationPolicy';

import { getDefaultToolRegistry } from '@tools/registry';
import {
  getDisabledToolNames,
  getUnavailableToolNamesCached,
} from '@tools/toolAvailability';
import { notifyUnavailableTools } from '@tools/toolUnavailableNotification';
import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { ToolUseCycleNode } from './nodes/ToolUseCycleNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import {
  findLastAssistantText,
  extractTouchedFiles,
  migrateSharedState,
  type ToolUseRunShared,
} from './nodes/types';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';

export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  onFollowUpConsumed?: () => void;
  /** When true, delegation tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
  /** Fires before the subagent enters WAITING, delivering the last response to the orchestrator. */
  onBeforeWaiting?: (
    lastResponse: string | undefined,
    touchedFiles: string[],
  ) => void | Promise<void>;
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
}

export interface RunToolUseFlowResult {
  status: EndGroupStatus;
  lastResponse?: string;
  /** Workspace-relative paths of files edited by tool calls during this session. */
  touchedFiles?: string[];
}

export interface ToolUseFlowContext {
  readonly session: ToolUseSessionLifecycle;
  readonly modelHandler: ToolUseServices['modelHandler'];
  readonly runtimeHost: ToolUseServices['runtimeHost'];
  interrupt(): void;
}

export type ToolUseFlowSetupCallback = (context: ToolUseFlowContext) => void;

function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry,
  logger: { warn: (msg: string) => void },
  delegationBlocked: boolean,
): { tools: ToolDefinition[]; delegationTrimmed: boolean } {
  const disabled = getDisabledToolNames();
  const unavailable = getUnavailableToolNamesCached();
  const missingDependency: string[] = [];

  // Don't warn on routine filtering outcomes (user-disabled, unavailable,
  // not in registry): they fire on every tool-use cycle and drown out real
  // issues. Agent YAML typos are surfaced once at load time by
  // `resolveToolDefinitions`; missing external deps are surfaced via
  // `notifyUnavailableTools` below.
  const toolConfigs = Array.isArray(tools) ? tools : [];
  let delegationTrimmed = false;
  const resolved = toolConfigs
    .map((config) => (typeof config === 'string' ? { name: config } : config))
    .filter((def) => {
      if (DELEGATION_TOOLS.has(def.name) && delegationBlocked) {
        delegationTrimmed = true;
        return false;
      }
      if (disabled.has(def.name)) return false;
      if (unavailable.has(def.name)) {
        missingDependency.push(def.name);
        return false;
      }
      if (!registry.has(def.name)) return false;
      return true;
    });

  // Inject memory tool into all tool-use agents (including subagents)
  // so they share the same /memories directory.
  const memoryEnabled = getGlobalState().get<boolean>(
    GlobalStateKey.MEMORY_ENABLED,
    true,
  );
  if (memoryEnabled && !resolved.some((d) => d.name === 'memory')) {
    const memoryTool = registry.get('memory');
    if (memoryTool) {
      resolved.push(memoryTool.definition);
    } else {
      logger.warn('Memory tool not found in registry');
    }
  }

  if (missingDependency.length) {
    notifyUnavailableTools(missingDependency);
  }

  return { tools: resolved, delegationTrimmed };
}

export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  toolRegistry?: IToolRegistry,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, runtimeHost, streamId, executionId, setting, onInterrupt } =
    input;
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);
  const registry = toolRegistry ?? getDefaultToolRegistry();
  const delegationDepth = input.delegationDepth ?? 0;
  const delegationConfig = readNestedDelegationConfig();
  const delegationGate = evaluateDelegationGate(
    delegationDepth,
    delegationConfig,
  );
  const { tools: resolvedTools, delegationTrimmed } = resolveTools(
    setting.tools,
    registry,
    logger,
    !delegationGate.allowed,
  );

  const kv = getExecutionStore(executionId);

  const services: ToolUseServices<C> = {
    ...input,
    runtimeHost,
    session: sessionLifecycle,
    resolvedTools,
    toolRegistry: registry,
    snapshot: input.resumeSnapshot ?? null,
    onRoundFinalized: input.onRoundFinalized ?? (async () => {}),
    persistTodos: (todos) => kv.writeTodos(todos),
    delegationDepth,
    delegationConfig,
    delegationTrimmed,
  };

  const flowContext: ToolUseFlowContext = {
    session: sessionLifecycle,
    modelHandler: input.modelHandler,
    runtimeHost,
    interrupt(): void {
      onInterrupt?.();
      clearRetryRequest(streamId);
      clearPlanApprovalForStream(streamId);
      sessionLifecycle.interrupt();
    },
  };

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;

  let shared: ToolUseRunShared = {
    messages: [],
    shouldSkipCycle: false,
    stateSlices: null,
  };

  try {
    registerInterruptible(streamId, flowContext);
    onSetup?.(flowContext);
    let flowRecord: FlowRecord | null = null;
    try {
      flowRecord = (await kv.read<FlowRecord>(flowKey(executionId))) ?? null;
    } catch {
      logger.debug('Resume parse failed, starting fresh');
    }
    if (flowRecord?.shared) {
      logger.debug('Resuming tool-use flow from persistence');
      const migrationResult = migrateSharedState(flowRecord.shared);
      if (migrationResult === null) {
        logger.warn('Failed to parse flow record shared state, starting fresh');
        await kv.delete(flowKey(executionId));
        flowRecord = null;
      } else if (migrationResult.migrated) {
        logger.debug('Migrated legacy shared state to flat format');
        flowRecord.shared = migrationResult.data;
        await kv.write(flowKey(executionId), flowRecord);
      }
    }

    const prepareNode = new ToolUsePrepareNode<C>();
    const cycleNode = new ToolUseCycleNode<C>();
    const waitNode = new ToolUseWaitNode<C>();
    prepareNode.next(cycleNode);
    cycleNode.next(waitNode);
    waitNode.on(FlowTransition.CONTINUE, cycleNode);
    const pf = new PersistedFlow<
      ToolUseRunShared,
      Record<string, unknown>,
      ToolUseServices<C>
    >(prepareNode, kv);
    pf.setServices(services);
    pf.setProjection(async (s, store) => {
      const todos = s.stateSlices?.workspaceSnapshot?.workPlan?.todos;
      if (Array.isArray(todos) && todos.length) await store.writeTodos(todos);
      if (s.messages.length) await store.writeConversation(s.messages);
    });
    await pf.run(shared);
    // Re-read shared from the flow record — PersistedFlow deep-clones the
    // initial shared via structuredClone, so nodes mutate the clone, not the
    // original object.  Without this, reads of lastError, messages, etc. below
    // would always see the stale initial values.
    shared = (await pf.getShared()) ?? shared;

    if (shared.lastError) {
      status = END_GROUP_STATUS.ERROR;
      // Re-throw so runFlowWithLifecycle logs the error and shows
      // the user notification. State was already projected per-step.
      throw new Error(shared.lastError.message);
    } else {
      const execStatus = input.checkInterruption()
        ? EXECUTION_STATUS.INTERRUPTED
        : EXECUTION_STATUS.COMPLETED;
      status = executionToEndStatus(execStatus) as EndGroupStatus;
    }
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    if (shared.userCancelledRetry) {
      logger.debug('Flow record preserved for resume after retry cancellation');
    } else {
      try {
        await kv.delete(flowKey(executionId));
      } catch {
        // Ignore cleanup errors
      }
    }

    sessionLifecycle.dispose();
    clearPlanApprovalForStream(streamId);
    unregisterInterruptible(streamId);
  }

  const lastResponse = findLastAssistantText(shared.messages, (m) =>
    input.modelHandler.extractAssistantText(m),
  );
  const touchedFiles = extractTouchedFiles(shared.stateSlices);

  return {
    status,
    lastResponse,
    touchedFiles: touchedFiles.length ? touchedFiles : undefined,
  };
}
