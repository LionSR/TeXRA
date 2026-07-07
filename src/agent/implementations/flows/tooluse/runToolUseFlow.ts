// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - agent
import { getExecutionStore } from '@agent/storage';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  modelHandlerCompatibilityKey,
} from '@agent/runtime/ModelFactory';
import { inferPersistedModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import { currentSession } from '@agent/runtime/SessionHandle';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  PersistedFlow,
  flowKey,
  stampFlowRecordSchemaVersion,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import type { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import { deriveRunOutcome } from '@common/constants/streamStatus';
import { attachProviderError } from '@common/errors/sdkErrorUtils';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  toProviderErrorFromRetry,
  type RunOutcome,
} from '@shared/schemas';
import type { SubagentProgressUpdate } from '@shared/schemas';

// Local imports - tools and flow
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
import {
  currentModelFromUserChannels,
  setToolUseSharedModel,
} from './modelSwitchState';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type {
  ToolUseBeforeWaitingCallback,
  ToolUseServices,
} from './ToolUseServices';

export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  onFollowUpConsumed?: () => void;
  /** When true, delegation tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
  /** Tools unavailable because the current host/runtime cannot support them. */
  runtimeUnavailableTools?: readonly string[];
  /** Fires before the subagent enters WAITING, delivering the last response to the orchestrator. */
  onBeforeWaiting?: ToolUseBeforeWaitingCallback;
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Stop after one cycle instead of waiting for a conversational follow-up. */
  stopAfterCycle?: boolean;
  /** Fires after a running tool-use chat changes its model. */
  onModelChanged?: (
    modelHandler: ToolUseServices['modelHandler'],
    model: string,
  ) => void;
  /** Runtime feature registry for auto-injected tools. */
  toolInjections?: ToolInjectionRegistry;
}

export interface RunToolUseFlowResult {
  outcome: RunOutcome | typeof STREAM_PHASE.WAITING;
  lastResponse?: string;
  /** Workspace-relative paths of files edited by tool calls during this session. */
  touchedFiles?: string[];
  /**
   * Total model cost (USD) accumulated by this run, including any subagents
   * it delegated to (rolled up at the delegation boundary). Used by parent
   * runs.
   */
  totalCostUsd?: number;
}

export class ToolUseFlowError extends Error {
  constructor(
    message: string,
    readonly result: RunToolUseFlowResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolUseFlowError';
  }
}

export function getToolUseFlowErrorResult(
  error: unknown,
): RunToolUseFlowResult | undefined {
  return error instanceof ToolUseFlowError ? error.result : undefined;
}

export interface ToolUseFlowContext {
  readonly session: ToolUseSessionLifecycle;
  readonly modelHandler: ToolUseServices['modelHandler'];
  readonly runtimeHost: AgentRuntimeHost;
  readonly model: string;
  interrupt(): void;
  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
}

export type ToolUseFlowSetupCallback = (
  context: ToolUseFlowContext,
) => void | (() => void);

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
  const { logger, setting, onInterrupt } = input;
  const { runtimeHost, streamId, executionId } = useLaunchRunContext();
  // Capture the run's session at setup (inside the run's ALS). The interrupt
  // closure below fires from the host thread outside the ALS, so it must use
  // this captured handle, not a fresh currentSession() lookup.
  const runSession = currentSession();
  const sessionLifecycle = new ToolUseSessionLifecycle(
    streamId,
    runSession.followUps,
  );
  const registry = toolRegistry ?? getDefaultToolRegistry();
  const delegationDepth = input.delegation?.delegationDepth ?? 0;
  const { tools: resolvedTools } = await resolveAgentTools({
    tools: setting.tools,
    registry,
    logger,
    approvalPromptsUnavailable: input.delegation?.approvalPromptsUnavailable,
    runtimeUnavailableTools: input.runtimeUnavailableTools,
    toolInjections: input.toolInjections,
  });

  const kv = getExecutionStore(executionId);

  const services: ToolUseServices<C> = {
    ...input,
    session: sessionLifecycle,
    resolvedTools,
    toolRegistry: registry,
    snapshot: input.resumeSnapshot ?? null,
    onRoundFinalized: input.onRoundFinalized ?? (async () => {}),
    persistTodos: (todos) => kv.writeTodos(todos),
    fileService: new TaskRunFileService(executionId),
    delegation: { ...input.delegation, delegationDepth },
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

    const nextAgentConfig = { ...services.config, model };
    await kv.writeConfig(nextAgentConfig);

    services.modelHandler = nextHandler;
    services.config.model = model;
    services.userVarChannels.transient.MODEL = model;

    switchedHandlers.add(nextHandler);
    if (previousHandler !== input.modelHandler) {
      previousHandler.dispose();
      switchedHandlers.delete(previousHandler);
    }
    logger.emit({
      type: 'run.config',
      streamId,
      executionId,
      config: services.config,
    });
    runtimeHost.emit('setTaskState', {
      streamId,
      executionId,
      taskState: agentConfigToTaskState(services.config),
    });
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
      runSession.interactions.cancelForStream(streamId, 'Run interrupted.');
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

  let outcome: RunToolUseFlowResult['outcome'] = RUN_OUTCOME.CANCELLED;
  let lastResponse: string | undefined;
  let touchedFiles: string[] | undefined;
  let totalCostUsd: number | undefined;
  let teardownSetup: (() => void) | undefined;
  const compatibilityKey = activeModelHandlerCompatibilityKey(
    services.modelHandler,
  );

  let shared: ToolUseRunShared = {
    messages: [],
    modelHandlerCompatibilityKey: compatibilityKey,
    shouldSkipCycle: false,
    stateSlices: null,
  };

  try {
    runSession.interrupts.register(streamId, flowContext);
    teardownSetup = onSetup?.(flowContext) ?? undefined;
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
      } else {
        let migratedData = migrationResult.data;
        let shouldWriteShared = migrationResult.migrated;
        const sharedModel = migratedData.stateSlices
          ? (currentModelFromUserChannels(
              migratedData.stateSlices.userChannels,
            ) ?? services.config.model)
          : services.config.model;
        const backfillCompatibilityKey =
          inferPersistedModelHandlerCompatibilityKey(
            sharedModel,
            migratedData.messages,
          ) ?? compatibilityKey;
        if (
          !migratedData.modelHandlerCompatibilityKey &&
          backfillCompatibilityKey
        ) {
          logger.debug(
            'Backfilled tool-use model-handler compatibility key in shared state.',
          );
          migratedData = {
            ...migratedData,
            modelHandlerCompatibilityKey: backfillCompatibilityKey,
          };
          shouldWriteShared = true;
        }
        if (shouldWriteShared) {
          if (migrationResult.migrated) {
            logger.debug('Migrated legacy shared state to flat format');
          }
          flowRecord.shared = migratedData;
          await kv.write(
            flowKey(executionId),
            stampFlowRecordSchemaVersion(flowRecord),
          );
        }
      }
    }

    const prepareNode = new ToolUsePrepareNode<C>();
    const cycleNode = new ToolUseCycleNode<C>();
    const waitNode = new ToolUseWaitNode<C>();
    prepareNode.next(cycleNode);
    cycleNode.next(waitNode);
    waitNode.on(FlowTransition.CONTINUE, cycleNode);
    waitNode.on(FlowTransition.WAITING, waitNode);
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
    const finalAction = await pf.run(shared);
    // Re-read shared from the flow record — PersistedFlow deep-clones the
    // initial shared via structuredClone, so nodes mutate the clone, not the
    // original object.  Without this, reads of lastError, messages, etc. below
    // would always see the stale initial values.
    shared = (await pf.getShared()) ?? shared;

    lastResponse =
      findLastAssistantText(shared.messages, (m) =>
        services.modelHandler.extractAssistantText(m),
      ) ||
      shared.lastResponse ||
      undefined;
    totalCostUsd =
      shared.stateSlices?.runStateSnapshot.usageAccumulator.totals.totalCost;
    const extractedTouchedFiles = extractTouchedFiles(shared.stateSlices);
    touchedFiles = extractedTouchedFiles.length
      ? extractedTouchedFiles
      : undefined;

    if (
      finalAction === FlowTransition.WAITING &&
      input.isSubagent === true &&
      input.onBeforeWaiting !== undefined &&
      shared.deliveredToOrchestrator === true
    ) {
      outcome = STREAM_PHASE.WAITING;
    } else {
      const isInterrupted = input.checkInterruption();
      const interruptedAfterDeliveredSubagentResult =
        input.isSubagent &&
        shared.deliveredToOrchestrator === true &&
        isInterrupted;
      outcome = deriveRunOutcome({
        failed: Boolean(shared.lastError),
        cancelled: isInterrupted && !interruptedAfterDeliveredSubagentResult,
      });
    }
    if (shared.lastError) {
      // Re-throw so runFlowWithLifecycle logs the error and shows
      // the user notification, while preserving terminal run accounting.
      // Attach the full structured provider error so downstream error
      // formatters can surface statusCode, provider, etc. without
      // sniffing the message string.
      const err = new ToolUseFlowError(shared.lastError.message, {
        outcome,
        lastResponse,
        touchedFiles,
        totalCostUsd,
      });
      attachProviderError(err, toProviderErrorFromRetry(shared.lastError));
      throw err;
    }
  } finally {
    activePersistedFlow = undefined;
    teardownSetup?.();
    teardownSetup = undefined;
    if (outcome === STREAM_PHASE.WAITING) {
      logger.debug('Flow record preserved for native subagent WAITING');
    } else if (shared.userCancelledRetry) {
      logger.debug('Flow record preserved for resume after retry cancellation');
    } else {
      try {
        await kv.delete(flowKey(executionId));
      } catch {
        // Ignore cleanup errors
      }
    }

    // WAITING outcome: leave the follow-up queue live, matching the flow
    // record preserved above. A delegate_agent follow-up can race into it via
    // sendFollowUp's 'active' branch between the WAITING transition inside
    // ToolUseWaitNode and this teardown — the tool-use flow context detaches
    // above, but the stream doesn't leave WAITING until resume, so the same
    // live queue instance is what a genuine kill (see ExecutionRegistry.
    // terminate's waiting-cleanup path) or resume drains instead of a
    // `dispose()` here silently discarding it.
    if (outcome !== STREAM_PHASE.WAITING) {
      sessionLifecycle.dispose();
    }
    runSession.interactions.cancelForStream(streamId, 'Run ended.');
    runSession.interrupts.unregister(streamId);
    for (const handler of switchedHandlers) {
      handler.dispose();
    }
  }

  return {
    outcome,
    lastResponse,
    touchedFiles,
    totalCostUsd,
  };
}
