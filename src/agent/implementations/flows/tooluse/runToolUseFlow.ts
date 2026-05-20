import { MODEL_CONFIGS } from 'llm-zoo';

import { getExecutionStore } from '@agent/storage';
import { createModelHandler } from '@agent/runtime/ModelFactory';
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
import { listToolInjections } from '@agent/runtime/toolInjection';
import { readNestedDelegationConfig } from '@agent/runtime/delegationPolicy';
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
  ) => boolean | void | Promise<boolean | void>;
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Fires after a running tool-use chat changes its model. */
  onModelChanged?: (
    modelHandler: ToolUseServices['modelHandler'],
    model: string,
  ) => void;
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
  readonly model: string;
  interrupt(): void;
  requestImmediateCompaction(): void;
  switchModel(model: string): Promise<void>;
}

export type ToolUseFlowSetupCallback = (context: ToolUseFlowContext) => void;

const IMMEDIATE_COMPACTION_FOLLOW_UP =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';

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

  const resolvedNames = new Set(resolved.map((d) => d.name));
  for (const injection of listToolInjections()) {
    if (!injection.shouldInject()) continue;
    if (resolvedNames.has(injection.toolName)) continue;
    const tool = registry.get(injection.toolName);
    if (tool) {
      resolved.push(tool.definition);
      resolvedNames.add(injection.toolName);
    } else {
      logger.warn(`Injected tool not found in registry: ${injection.toolName}`);
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
  const switchedHandlers = new Set<ToolUseServices<C>['modelHandler']>();

  const switchModel = async (model: string): Promise<void> => {
    const nextConfig = MODEL_CONFIGS[model];
    if (!nextConfig) {
      throw new Error(`Model ${model} not found in MODEL_CONFIGS`);
    }
    if (services.config.model === model) return;

    const previousHandler = services.modelHandler;
    const nextHandler = (await createModelHandler(
      nextConfig,
    )) as ToolUseServices<C>['modelHandler'];
    if (nextHandler.constructor !== previousHandler.constructor) {
      nextHandler.dispose();
      throw new Error(
        'Cannot switch this conversation to a model with a different conversation format. Start a new chat to use that model.',
      );
    }
    nextHandler.setAgentCategory(setting.agentCategory);
    nextHandler.setLogger(logger);

    services.modelHandler = nextHandler;
    services.config.model = model;
    services.userVarChannels.transient.MODEL = model;

    switchedHandlers.add(nextHandler);
    if (previousHandler !== input.modelHandler) {
      previousHandler.dispose();
      switchedHandlers.delete(previousHandler);
    }
    input.onModelChanged?.(nextHandler, model);
  };

  const flowContext: ToolUseFlowContext = {
    session: sessionLifecycle,
    get modelHandler() {
      return services.modelHandler;
    },
    runtimeHost,
    get model() {
      return services.config.model;
    },
    interrupt(): void {
      onInterrupt?.();
      clearRetryRequest(streamId);
      clearPlanApprovalForStream(streamId);
      sessionLifecycle.interrupt();
    },
    requestImmediateCompaction(): void {
      services.modelHandler.requestCompaction();
      if (!sessionLifecycle.hasQueuedFollowUp()) {
        sessionLifecycle.appendSyntheticFollowUp(
          IMMEDIATE_COMPACTION_FOLLOW_UP,
        );
      }
    },
    switchModel,
  };

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  let lastResponse: string | undefined;
  let touchedFiles: string[] | undefined;

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
      const isInterrupted = input.checkInterruption();
      const interruptedAfterDeliveredSubagentResult =
        input.isSubagent &&
        shared.deliveredToOrchestrator === true &&
        isInterrupted;
      const execStatus =
        isInterrupted && !interruptedAfterDeliveredSubagentResult
          ? EXECUTION_STATUS.INTERRUPTED
          : EXECUTION_STATUS.COMPLETED;
      status = executionToEndStatus(execStatus) as EndGroupStatus;
      lastResponse = findLastAssistantText(shared.messages, (m) =>
        services.modelHandler.extractAssistantText(m),
      );
      const extractedTouchedFiles = extractTouchedFiles(shared.stateSlices);
      touchedFiles = extractedTouchedFiles.length
        ? extractedTouchedFiles
        : undefined;
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
    for (const handler of switchedHandlers) {
      handler.dispose();
    }
  }

  return {
    status,
    lastResponse,
    touchedFiles,
  };
}
