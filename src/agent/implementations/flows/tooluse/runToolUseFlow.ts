import { MODEL_CONFIGS } from 'llm-zoo';

import { getExecutionStore } from '@agent/storage';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  modelHandlerCompatibilityKey,
} from '@agent/runtime/ModelFactory';
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
import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import { readNestedDelegationConfig } from '@agent/runtime/delegationPolicy';
import { executionToEndStatus } from '@common/constants/streamStatus';
import {
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  type EndGroupStatus,
} from '@shared/schemas';
import type { SubagentProgressUpdate } from '@shared/schemas';
import { evaluateDelegationGate } from '@shared/constants/delegationPolicy';

import { getDefaultToolRegistry } from '@tools/registry';
import { TaskRunFileService } from '@utils/files';
import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { ToolUseCycleNode } from './nodes/ToolUseCycleNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import {
  findLastAssistantText,
  extractTouchedFiles,
  migrateSharedState,
  type ToolUseRunShared,
} from './nodes/types';
import { setToolUseSharedModel } from './modelSwitchState';
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
  /** When true, approval-gated tools are filtered out before model invocation. */
  approvalPromptsUnavailable?: boolean;
  /** Fires before the subagent enters WAITING, delivering the last response to the orchestrator. */
  onBeforeWaiting?: (
    lastResponse: string | undefined,
    touchedFiles: string[],
  ) => boolean | void | Promise<boolean | void>;
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Stop after one cycle instead of waiting for a conversational follow-up. */
  stopAfterCycle?: boolean;
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
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
}

export type ToolUseFlowSetupCallback = (context: ToolUseFlowContext) => void;

type ToolUsePersistedFlow<C> = PersistedFlow<
  ToolUseRunShared,
  Record<string, unknown>,
  ToolUseServices<C>
>;

const IMMEDIATE_COMPACTION_FOLLOW_UP =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';
const MODEL_SWITCH_DIFFERENT_FORMAT_ERROR =
  'Cannot switch this conversation to a model with a different conversation format. Start a new chat to use that model.';
const MODEL_SWITCH_DIFFERENT_FORMAT_REASON =
  'different conversation format; start new chat';

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
  const { tools: resolvedTools, delegationTrimmed } = await resolveAgentTools({
    tools: setting.tools,
    registry,
    logger,
    delegationBlocked: !delegationGate.allowed,
    approvalPromptsUnavailable: input.approvalPromptsUnavailable,
  });

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
    fileService: new TaskRunFileService(executionId),
    delegationDepth,
    delegationConfig,
    delegationTrimmed,
  };
  const switchedHandlers = new Set<ToolUseServices<C>['modelHandler']>();
  let activePersistedFlow: ToolUsePersistedFlow<C> | undefined;

  const persistModelSwitch = async (model: string): Promise<void> => {
    const flow = activePersistedFlow;
    const liveShared = await flow?.getShared();
    if (!flow || !liveShared || !setToolUseSharedModel(liveShared, model)) {
      throw new Error(
        'Cannot save the model switch because the resumable session state is unavailable.',
      );
    }
    await flow.setShared(liveShared);
  };

  const modelSwitchDisabledReason = (model: string): string | undefined => {
    if (services.config.model === model) return undefined;

    const nextConfig = MODEL_CONFIGS[model];
    if (!nextConfig) return `Model ${model} not found in MODEL_CONFIGS`;

    const activeKey = activeModelHandlerCompatibilityKey(services.modelHandler);
    if (!activeKey) {
      // Non-factory handlers still reach switchModel's constructor-reference
      // check. Keep the UI permissive rather than guessing their format here.
      return undefined;
    }
    const nextKey = modelHandlerCompatibilityKey(nextConfig);
    if (!nextKey) return `Unsupported model provider: ${nextConfig.provider}`;
    return activeKey === nextKey
      ? undefined
      : MODEL_SWITCH_DIFFERENT_FORMAT_REASON;
  };

  const switchModel = async (model: string): Promise<void> => {
    const nextConfig = MODEL_CONFIGS[model];
    if (!nextConfig) {
      throw new Error(`Model ${model} not found in MODEL_CONFIGS`);
    }
    if (services.config.model === model) return;

    const disabledReason = modelSwitchDisabledReason(model);
    if (disabledReason) {
      throw new Error(
        disabledReason === MODEL_SWITCH_DIFFERENT_FORMAT_REASON
          ? MODEL_SWITCH_DIFFERENT_FORMAT_ERROR
          : disabledReason,
      );
    }

    const previousHandler = services.modelHandler;
    const nextHandler = (await createModelHandler(
      nextConfig,
    )) as ToolUseServices<C>['modelHandler'];
    // Backstop for untagged/custom handlers and future route drift. This is a
    // constructor-reference comparison, so CLI minification cannot affect it.
    if (nextHandler.constructor !== previousHandler.constructor) {
      nextHandler.dispose();
      throw new Error(MODEL_SWITCH_DIFFERENT_FORMAT_ERROR);
    }
    try {
      await persistModelSwitch(model);
    } catch (error) {
      nextHandler.dispose();
      throw error;
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
    modelSwitchDisabledReason,
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
    const pf: ToolUsePersistedFlow<C> = new PersistedFlow(prepareNode, kv);
    activePersistedFlow = pf;
    pf.setServices(services);
    pf.setProjection(async (s, store) => {
      const todos = s.stateSlices?.workspaceSnapshot?.workPlan?.todos;
      if (Array.isArray(todos) && todos.length) await store.writeTodos(todos);
      if (s.messages.length) await store.writeConversation(s.messages);
      const currentTouchedFiles = extractTouchedFiles(s.stateSlices);
      if (currentTouchedFiles.length) {
        await store.writeWorkspaceFiles(currentTouchedFiles);
      }
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
      lastResponse =
        findLastAssistantText(shared.messages, (m) =>
          services.modelHandler.extractAssistantText(m),
        ) ||
        shared.lastResponse ||
        undefined;
      const extractedTouchedFiles = extractTouchedFiles(shared.stateSlices);
      touchedFiles = extractedTouchedFiles.length
        ? extractedTouchedFiles
        : undefined;
    }
  } finally {
    activePersistedFlow = undefined;
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
