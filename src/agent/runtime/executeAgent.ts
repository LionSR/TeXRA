import * as path from 'path';

import { ZodError } from 'zod';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  resolveAgent,
  isRemoteAgent,
  getAgent,
  type ResolvedAgent,
} from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import { createMergeOutputFileLocationGetter } from '@agent/utils/outputFileUtils';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  runToolUseFlow,
  type IToolUseSession,
} from '@agent/implementations/flows/tooluse';
import { runReflectionFlow } from '@agent/implementations/flows/reflection/runReflectionFlow';
import type { AgentCore } from '@agent/implementations/flows/common/BaseFlowServices';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import {
  AgentCategory,
  isWorkflowSetting,
  type AgentWorkflowSetting,
  type AgentToolUseSetting,
} from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import {
  loadAgentSettingAndPrompts,
  ensureAgentCategoryForSource,
} from '@agent/runtime/agentLoad';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { computeDelegationDepthFromStorage } from '@agent/runtime/delegationPolicy';
import { buildUserVars } from '@agent/utils/userVars';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import {
  AgentError,
  classifyAgentError,
  getSdkErrorMessage,
  toErrorMessage,
} from '@common/errors';
import { normalizeRunId } from '@common/constants/runIds';
import {
  AgentLogger,
  AgentUsageReporter,
  getStreamTabId,
  type AgentLogStage,
} from '@logger/index';
import {
  STREAM_STATUS,
  END_GROUP_STATUS,
  type StreamTabId,
  type ExecutionId,
  type StorageKey,
  type OutputFileInfo,
  type RoundOutput,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { TaskRunFileService } from '@utils/files';
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';

import { StreamStatusService } from './StreamStatusService';
import { getAgentRuntimeHost, type AgentRuntimeHost } from './AgentRuntimeHost';
import { createInterruptCallbacks } from './InterruptManager';
import {
  trackExecution,
  untrackExecution,
  updateExecutionProgress,
  AgentExecutionHandle,
} from './executionRegistry';
import { generateSessionDescription } from './sessionDescription';
import { getRunStorageService } from './RunStorageService';
import {
  createRunContext,
  withRunContext,
  type RunContext,
  type RunCoordinators,
} from './RunContext';
import { retainRunCoordinatorsForStream } from './runCoordinators';
import { AgentProposalCoordinator } from './AgentProposalCoordinator';
import { PlanApprovalCoordinator } from './PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from './RetryRequestCoordinator';
import type {
  AgentFlowResult,
  CompileFailureSummary,
  OutputFileSummary,
} from './AgentFlowResult';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

interface AgentLaunchContext extends AgentCore {
  runtimeHost: AgentRuntimeHost;
  usageMonitor: UsageMonitor;
  storageKey: StorageKey;
  parentStage: AgentLogStage;
  coordinators: RunCoordinators;
}

function createExecutionRunContext(ctx: AgentLaunchContext): RunContext {
  return createRunContext({
    runtimeHost: ctx.runtimeHost,
    streamId: ctx.streamId,
    executionId: ctx.executionId,
    logger: ctx.logger,
    approvals: {},
    coordinators: ctx.coordinators,
    toolRunContext: {
      streamId: ctx.streamId,
      executionId: ctx.executionId,
      model: ctx.config.model,
      agentName: ctx.config.agent,
      workingDirectory: ctx.workingDirectory,
      runtimeHost: ctx.runtimeHost,
      delegationDepth: ctx.delegationDepth,
      delegationConfig: ctx.delegationConfig,
    },
  });
}

async function withExecutionRunContext<T>(
  ctx: AgentLaunchContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  const release = retainRunCoordinatorsForStream(
    ctx.streamId,
    ctx.coordinators,
  );
  try {
    return await withRunContext(createExecutionRunContext(ctx), fn);
  } finally {
    release();
  }
}

export async function getAgentPath(
  agentIdentifier: string,
  options?: { runtimeHost?: AgentRuntimeHost },
): Promise<ResolvedAgent> {
  const result = resolveAgent(agentIdentifier);
  if (result) return result;

  (options?.runtimeHost ?? getAgentRuntimeHost()).emit(
    'showAgentConfigBanner',
    { agentName: agentIdentifier },
  );
  throw new AgentError(`Could not find agent: ${agentIdentifier}`);
}

async function validateModelExists(
  modelName: string,
  runtimeHost: AgentRuntimeHost,
): Promise<void> {
  if (modelName in MODEL_CONFIGS) return;

  runtimeHost.emit('requestShowInstruction', {
    key: 'modelNotRecognized',
    message: `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
    actions: [
      {
        title: 'Model Documentation',
        command: 'texra.openDoc',
        args: ['models'],
      },
    ],
    showSuppress: false,
  });
  throw new AgentError(`Model ${modelName} not found in MODEL_CONFIGS`);
}

/**
 * Create a "Run:" stage, optionally logging a user instruction first.
 *
 * ORDERING INVARIANT: The instruction is emitted BEFORE the stage is created.
 * At this point no group context exists, so the message gets no groupId and
 * its timestamp precedes the stage's startTime.  The chronological timeline
 * therefore renders the instruction *before* the run group.
 *
 * Both operations live in one function so the ordering cannot be
 * accidentally reversed by future edits.
 */
async function beginRunStage(
  agentLogger: AgentLogger,
  label: string,
  instruction: string | undefined,
): Promise<AgentLogStage> {
  if (instruction) {
    agentLogger.userMessage(instruction);
  }
  return agentLogger.stage(label);
}

interface AgentLaunchInput {
  configPayload: AgentConfigPayload;
  executionId?: ExecutionId;
  runtimeHost: AgentRuntimeHost;
  streamTabIdOverride?: StreamTabId;
  taskType?: string;
  /** Fires after streamId is assigned but before setActiveStream is emitted. */
  onBeforeActivation?: (streamId: StreamTabId) => void;
  /** When true, reject if configPayload.agentCategory doesn't match the YAML-defined category. */
  enforceCategory?: boolean;
  /** Skip the `requestShowError` toast -- for callers that show their own UI. */
  suppressErrorNotification?: boolean;
}

async function assembleAgentLaunchContext(
  input: AgentLaunchInput,
  executionId: ExecutionId,
  runtimeHost: AgentRuntimeHost,
  reservedStreamId: StreamTabId | undefined,
  onActivated: (streamId: StreamTabId) => void,
): Promise<AgentLaunchContext> {
  const { configPayload } = input;
  const fullConfig = AgentConfigSchema.parse(configPayload);
  const resolution = await getAgentPath(fullConfig.agent, { runtimeHost });
  const [loadedSettings, prompt] = await loadAgentSettingAndPrompts(
    resolution,
    { outputFiles: fullConfig.outputFiles },
  );
  const setting = ensureAgentCategoryForSource(
    loadedSettings,
    resolution.entry.source,
  );

  // Block category mismatch: prevent launching a tool-use agent as a workflow
  // (or vice versa). Only enforced when the caller opts in via enforceCategory,
  // because many code paths pass pre-parsed configs where agentCategory was
  // prefaulted to Workflow by the schema (not explicitly chosen by the caller).
  if (
    input.enforceCategory &&
    configPayload.agentCategory &&
    configPayload.agentCategory !== setting.agentCategory
  ) {
    const suggestion =
      setting.agentCategory === AgentCategory.ToolUse
        ? 'delegate_agent'
        : 'delegate_workflow';
    throw new AgentError(
      `Agent '${fullConfig.agent}' is a ${setting.agentCategory} agent but was launched as ${configPayload.agentCategory}. Use ${suggestion} instead.`,
    );
  }

  await validateModelExists(fullConfig.model, runtimeHost);

  const config: AgentConfig = {
    ...fullConfig,
    agentCategory: setting.agentCategory,
  };

  const modelHandler = await createModelHandler(
    MODEL_CONFIGS[fullConfig.model],
  );

  const streamId =
    input.streamTabIdOverride ??
    reservedStreamId ??
    getStreamTabId(config.agent, fullConfig.model, { executionId });

  const agentLogger = new AgentLogger(streamId, true);
  const usageReporter = new AgentUsageReporter(
    agentLogger,
    streamId,
    setting.agentCategory,
    runtimeHost,
  );
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  input.onBeforeActivation?.(streamId);

  runtimeHost.emit('setActiveStream', {
    streamId,
    agentCategory: setting.agentCategory,
    isRemote: isRemoteAgent(fullConfig.agent),
  });
  onActivated(streamId);

  // Log the initial instruction as a user message so both workflow and
  // tool-use tabs display it inline with the stream log (no separate panel).
  const initialInstruction =
    config.instruction?.trim() && !input.streamTabIdOverride
      ? config.instruction.trim()
      : undefined;

  const parentStage = await beginRunStage(
    agentLogger,
    `Run: ${config.agent}`,
    initialInstruction,
  );
  const storageKey: StorageKey = parentStage.id
    ? normalizeRunId(parentStage.id)
    : (executionId as StorageKey);

  const agentPath = path.dirname(resolution.definitionPath);
  const buildVars = () =>
    buildUserVars(
      config,
      setting,
      prompt,
      agentPath,
      {
        isOpenai: modelHandler.isOpenai,
        isAnthropic: modelHandler.isAnthropic,
        isGoogle: modelHandler.isGoogle,
      },
      agentLogger,
    );

  const baseVars =
    setting.agentCategory === AgentCategory.ToolUse
      ? await buildVars()
      : await parentStage.stage('Init').then((s) => s.run(buildVars));

  const userVarChannels: UserVariableChannels = {
    input: Object.freeze(baseVars),
    transient: { ...baseVars },
  };

  const usageMonitor = new UsageMonitor(
    { capabilities: modelHandler.capabilities, config: modelHandler.config },
    { logger: agentLogger, usageReporter, storageKey, streamId },
    {
      agentName: config.agent,
      agentCategory: setting.agentCategory,
    },
  );

  return {
    config,
    setting,
    prompt,
    modelHandler,
    streamId,
    executionId,
    logger: agentLogger,
    parentStage,
    storageKey,
    userVarChannels,
    usageMonitor,
    runtimeHost,
    workingDirectory: configPayload.workingDirectory?.trim() || undefined,
    coordinators: {
      plan: new PlanApprovalCoordinator(),
      proposal: new AgentProposalCoordinator(),
      retry: new RetryRequestCoordinatorImpl(),
    },
  };
}

const STATUS_MESSAGES: Record<string, string> = {
  [STREAM_STATUS.INITIALIZING]: 'already launching',
  [STREAM_STATUS.RESUMING]: 'resuming',
  [STREAM_STATUS.RUNNING]: 'already running',
  [STREAM_STATUS.WAITING]: 'waiting for retry',
};

function acquireStreamOrThrow(
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
  taskType: string = 'Task',
): void {
  if (
    StreamStatusService.tryAcquire(streamId, {
      runtimeHost,
    })
  ) {
    return;
  }

  const status = StreamStatusService.get(streamId) ?? '';
  const statusMsg = STATUS_MESSAGES[status] || 'already running';
  throw new AgentError(
    `${taskType} "${streamId}" is ${statusMsg}. Please wait for it to complete or stop it first.`,
  );
}

/** Map workflow RoundOutput[] to OutputFileSummary[] for AgentFlowResult. */
function toOutputSummaries(roundOutputs: RoundOutput[]): OutputFileSummary[] {
  return roundOutputs.flatMap((r) =>
    r.outputs.map((o: OutputFileInfo) => ({
      round: r.round,
      relativePath:
        'relativePath' in o.location
          ? o.location.relativePath
          : o.location.absolutePath,
      absolutePath: o.location.absolutePath,
      location: o.location.kind,
      originalPath: o.lineage?.original?.absolutePath ?? null,
      added: o.diff?.added ?? null,
      removed: o.diff?.removed ?? null,
    })),
  );
}

function toCompileFailureSummaries(
  roundOutputs: RoundOutput[],
): CompileFailureSummary[] {
  return roundOutputs.flatMap((r) =>
    r.compileFailures.map((failure) => ({
      round: failure.round,
      displayName: failure.displayName,
      outputPath:
        failure.output.kind === 'external'
          ? failure.output.absolutePath
          : failure.output.relativePath,
      logPath: failure.logRelativePath,
      logAbsolutePath: failure.log.absolutePath,
    })),
  );
}

/** Create an onRoundCompleted callback that feeds progress into the execution registry and orchestrator. */
function createRoundProgressCallback(
  executionId: ExecutionId,
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
  onProgress?: (update: SubagentProgressUpdate) => void,
): (
  roundIndex: number,
  totalRounds: number,
  outputPaths?: readonly string[],
) => void {
  return (roundIndex, totalRounds, outputPaths) => {
    updateExecutionProgress(executionId, {
      currentRound: roundIndex,
      totalRounds,
    });
    onProgress?.({
      kind: 'round',
      currentRound: roundIndex,
      totalRounds,
      outputPaths: outputPaths ?? [],
    });
    runtimeHost.emit('updateConversationProgress', {
      streamId,
      progress: {
        conversationTurns: roundIndex + 1,
        toolCallCount: 0,
      },
    });
  };
}

async function runFlowWithLifecycle(
  ctx: AgentLaunchContext,
  streamId: StreamTabId,
  agentName: string,
  runner: () => Promise<AgentFlowResult>,
  options?: {
    isSubagent?: boolean;
    category?: 'workflow' | 'toolUse';
    parentStreamId?: StreamTabId;
    onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  },
): Promise<AgentFlowResult> {
  const category = options?.category ?? 'workflow';
  const parentStreamId = options?.parentStreamId ?? streamId;
  const handle = new AgentExecutionHandle(
    ctx.executionId,
    parentStreamId,
    streamId,
    agentName,
    category,
    ctx.runtimeHost,
  );
  trackExecution(handle);
  try {
    const result = await runner();
    await options?.onCompleted?.(result);
    await writeTerminalStatus(ctx.executionId, result.status).catch(() => {});

    untrackExecution(ctx.executionId);
    ctx.parentStage.end(result.status);

    if (!StreamStatusService.shouldPreserveOnCompletion(streamId)) {
      const status =
        result.status === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED;
      StreamStatusService.set(streamId, status, {
        runtimeHost: ctx.runtimeHost,
      });
    }
    logger.debug(`Task completed with status: ${result.status}`);
    return result;
  } catch (err) {
    const kind = classifyAgentError(err);
    const status =
      kind === 'abort' ? END_GROUP_STATUS.STOPPED : END_GROUP_STATUS.ERROR;
    const streamStatus =
      kind === 'abort' ? STREAM_STATUS.STOPPED : STREAM_STATUS.ERROR;
    await writeTerminalStatus(ctx.executionId, status).catch(() => {});
    untrackExecution(ctx.executionId);
    const errorMsg = `Error executing agent ${agentName}: ${getSdkErrorMessage(err)}`;

    // Log error BEFORE ending the group so it gets the correct groupId
    if (kind !== 'abort') {
      await ctx.logger.logError(errorMsg, err, {
        operation: `execute ${agentName}`,
      });
    }

    ctx.parentStage.end(status);
    StreamStatusService.set(streamId, streamStatus, {
      runtimeHost: ctx.runtimeHost,
    });

    // Subagents propagate errors to the orchestrator via FollowUpQueue —
    // don't show VS Code popups that would confuse the user.
    if (!options?.isSubagent) {
      if (kind === 'disk-full') {
        ctx.runtimeHost.emit('requestShowError', {
          message: getSdkErrorMessage(err),
        });
      } else if (kind === 'missing-api-key') {
        ctx.runtimeHost.emit('requestShowInstruction', {
          key: 'missingApiKey',
          message:
            'API key not found. Set your API key in the extension settings and run again.',
          actions: [
            { title: 'Set API Key', command: 'texra.setApiKey' },
            {
              title: 'Open Settings Guide',
              command: 'texra.openDoc',
              args: ['configuration'],
            },
          ],
          showSuppress: false,
        });
      } else if (kind === 'unexpected') {
        ctx.runtimeHost.emit('requestShowError', {
          message: errorMsg,
        });
      }
    }

    if (kind === 'abort') {
      return buildStoppedFlowResult(category, ctx.executionId, streamId);
    }

    throw new AgentError(errorMsg, { cause: err });
  } finally {
    // Release long-lived resources (e.g., WebSocket connections, keepalive intervals)
    // to prevent leaks when handler instances are discarded after execution.
    ctx.modelHandler.dispose();
  }
}

function buildStoppedFlowResult(
  category: 'workflow' | 'toolUse',
  executionId: ExecutionId,
  streamId: StreamTabId,
): AgentFlowResult {
  if (category === 'toolUse') {
    return {
      category,
      status: END_GROUP_STATUS.STOPPED,
      executionId,
      streamId,
    };
  }

  return {
    category,
    status: END_GROUP_STATUS.STOPPED,
    executionId,
    streamId,
    outputs: [],
    compileFailures: [],
  };
}

function buildFallbackNotification(config: AgentConfig) {
  const inputName = config.inputFile
    ? path.basename(config.inputFile)
    : 'selected input';
  const { outputFiles = [] } = config;
  const outputInfo =
    outputFiles.length > 1
      ? `to ${outputFiles.length} files`
      : outputFiles[0]
        ? `to ${path.basename(outputFiles[0])}`
        : '';
  return {
    agentName: config.agent,
    modelName: config.model,
    inputName,
    outputInfo,
  };
}

// ============================================================================
// Shared Orchestration
// ============================================================================

/**
 * Saga-style compensation for a failed stream activation.
 *
 *  - Pre-activation failure (no `activatedStreamId`): the UI tab was never
 *    registered. Release the reserved lock if we held it; the caller won't
 *    ever see a stream.
 *
 *  - Post-activation failure (`activatedStreamId` set): the UI tab is
 *    visible. Surface the failure on it and transition to ERROR so the
 *    tab doesn't hang in INITIALIZING.
 */
function compensateFailedActivation(args: {
  configPayload: AgentConfigPayload;
  reservedStreamId?: StreamTabId;
  activatedStreamId?: StreamTabId;
  runtimeHost: AgentRuntimeHost;
  err: unknown;
}): void {
  const {
    configPayload,
    reservedStreamId,
    activatedStreamId,
    runtimeHost,
    err,
  } = args;

  if (activatedStreamId) {
    new AgentLogger(activatedStreamId, true).logError(
      `Failed to start agent ${configPayload.agent}: ${getSdkErrorMessage(err)}`,
      err,
      { operation: `start ${configPayload.agent}` },
    );
    StreamStatusService.set(activatedStreamId, STREAM_STATUS.ERROR, {
      runtimeHost,
    });
    return;
  }

  if (reservedStreamId) {
    StreamStatusService.releaseIfInitializing(reservedStreamId, {
      runtimeHost,
    });
  }
}

/**
 * Resolves agent context and reserves the final stream id before the UI is
 * activated.
 *
 * Treats the `setActiveStream` emission as a transactional commit point:
 * resolution failures before that point release the lock silently; failures
 * after surface on the visible tab via {@link compensateFailedActivation}.
 */
async function buildAgentLaunchContext(
  input: AgentLaunchInput,
): Promise<AgentLaunchContext> {
  const { configPayload } = input;
  const { runtimeHost } = input;
  const executionId = input.executionId ?? generateExecutionId();
  if (
    !input.streamTabIdOverride &&
    (!configPayload.agent || !configPayload.model)
  ) {
    throw new AgentError('Missing required fields: model and/or agent');
  }

  const reservedStreamId = input.streamTabIdOverride
    ? undefined
    : getStreamTabId(configPayload.agent, configPayload.model, { executionId });
  if (reservedStreamId) {
    acquireStreamOrThrow(reservedStreamId, runtimeHost, input.taskType);
  }

  let activatedStreamId: StreamTabId | undefined;
  try {
    return await assembleAgentLaunchContext(
      input,
      executionId,
      runtimeHost,
      reservedStreamId,
      (streamId) => {
        activatedStreamId = streamId;
      },
    );
  } catch (err) {
    compensateFailedActivation({
      configPayload,
      reservedStreamId,
      activatedStreamId,
      runtimeHost,
      err,
    });
    if (!input.suppressErrorNotification && !(err instanceof ZodError)) {
      runtimeHost.emit('requestShowError', {
        message: toErrorMessage(err),
      });
    }
    throw err;
  }
}

// ============================================================================
// Public Entry Points
// ============================================================================

/** Options for executeAgent. */
export interface ExecuteAgentOptions {
  /** Host services used by the runtime to report progress/UI events. */
  runtimeHost?: AgentRuntimeHost;
  /** When true, proposal tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
  /**
   * When true, enforce that configPayload.agentCategory matches the agent's
   * YAML-defined category. Callers that explicitly set a category (e.g.
   * DelegationTools) should opt in; callers that pass pre-parsed configs with
   * prefaulted defaults (e.g. runExecuteCommand) should leave this off.
   */
  enforceCategory?: boolean;
  /** Parent stream ID for subagent lineage tracking. Defaults to own streamId. */
  parentStreamId?: StreamTabId;
  /**
   * Depth of this execution in the delegation chain. Root (user-initiated) is 0;
   * each delegate_agent / delegate_workflow call increments it. Used to gate
   * nested delegation based on the Multi-Agent settings. Defaults to 0.
   */
  delegationDepth?: number;
  /** Fires with the real streamId before the stream is activated (before UI sync). */
  onStreamResolved?: (streamId: StreamTabId) => void;
  /** Fires before a tool-use subagent enters WAITING, delivering interim result to orchestrator. */
  onBeforeWaiting?: (
    lastResponse: string | undefined,
    touchedFiles: string[],
  ) => void | Promise<void>;
  /** Fires when a tool-use session consumes queued follow-up instructions. */
  onFollowUpConsumed?: () => void;
  /** Fires on meaningful progress: todo changes, round completions, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Fires after flow completes but BEFORE untrackExecution, so follow-ups are enqueued before waiters resolve. */
  onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
}

export async function executeAgent(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
  options?: ExecuteAgentOptions,
): Promise<AgentFlowResult> {
  const runtimeHost = options?.runtimeHost ?? getAgentRuntimeHost();
  const ctx = await buildAgentLaunchContext({
    configPayload,
    executionId,
    runtimeHost,
    onBeforeActivation: options?.onStreamResolved,
    enforceCategory: options?.enforceCategory,
    suppressErrorNotification: options?.isSubagent,
  });
  ctx.delegationDepth = options?.delegationDepth ?? 0;
  return withExecutionRunContext(ctx, async () => {
    const { setting, streamId, config } = ctx;
    const { agent: agentName } = config;
    const { isSubagent } = options ?? {};

    // Fire-and-forget: generate AI session description from the user's instruction.
    // Triggered at the start so cancelled/errored sessions still get descriptions.
    // Applies to all agents including subagents so their progress tabs show
    // meaningful descriptions in multi-agent pipelines.
    generateSessionDescription(
      ctx.executionId,
      streamId,
      config,
      ctx.runtimeHost,
    ).catch(() => {});
    return runFlowWithLifecycle(
      ctx,
      streamId,
      agentName,
      async () => {
        // Pre-execution UI setup
        if (executionId) await ensureRunDir(executionId);
        StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
          runtimeHost: ctx.runtimeHost,
        });
        logger.info(`Starting task execution (streamId: ${streamId})`);
        logger.info(`Input file: ${config.inputFile}`);
        logger.debug(
          `Stream ID: ${streamId}, Agent: ${config.agent}, Model: ${config.model}`,
        );
        logger.debug(`Output files: ${config.outputFiles?.length ?? 0}`);
        // Subagents don't need to force-open the progress board or show notifications —
        // the orchestrator's stream is already visible.
        if (!isSubagent && !getRunStorageService().isViewVisible()) {
          ctx.runtimeHost.emit('requestEnsureProgressView', {
            fallbackNotification: buildFallbackNotification(config),
          });
        }
        ctx.runtimeHost.emit('setTaskState', {
          streamId,
          executionId,
          taskState: agentConfigToTaskState(config),
        });

        const taskStage = await logger.stage(
          `Task: ${agentName}@${config.model}`,
        );
        return taskStage.run(async () => {
          logger.info(`Executing ${agentName} with model ${config.model}`);
          const interrupts = createInterruptCallbacks();

          if (setting.agentCategory === AgentCategory.ToolUse) {
            let toolUseTurns = 0;
            const result = await runToolUseFlow({
              ...ctx,
              ...interrupts,
              onRoundFinalized: (run) =>
                ctx.usageMonitor.recordUsage(run, { runKind: 'tool-use' }),
              setting: ctx.setting as AgentToolUseSetting,
              isSubagent,
              onBeforeWaiting: options?.onBeforeWaiting,
              onProgress: (update) => {
                if (update.kind === 'overview') {
                  toolUseTurns++;
                  ctx.runtimeHost.emit('updateConversationProgress', {
                    streamId,
                    progress: {
                      conversationTurns: toolUseTurns,
                      toolCallCount: update.toolCallCount,
                    },
                  });
                }
                options?.onProgress?.(update);
              },
              onFollowUpConsumed: () => {
                ctx.runtimeHost.emit('updateQueuedFollowUps', {
                  streamId: ctx.streamId,
                });
                options?.onFollowUpConsumed?.();
              },
            });
            return {
              category: 'toolUse' as const,
              status: result.status,
              lastResponse: result.lastResponse,
              touchedFiles: result.touchedFiles,
              executionId: ctx.executionId,
              streamId,
            };
          }

          const onRoundCompleted = createRoundProgressCallback(
            ctx.executionId,
            streamId,
            ctx.runtimeHost,
            options?.onProgress,
          );
          const result = await runReflectionFlow({
            ...ctx,
            ...interrupts,
            onRoundFinalized: (run) =>
              ctx.usageMonitor.recordUsage(run, { runKind: 'workflow' }),
            setting: ctx.setting as AgentWorkflowSetting,
            parentStage: ctx.parentStage,
            onRoundCompleted,
          });
          return {
            category: 'workflow' as const,
            status: result.status,
            outputs: toOutputSummaries(result.roundOutputs),
            compileFailures: toCompileFailureSummaries(result.roundOutputs),
            executionId: ctx.executionId,
            streamId,
          };
        });
      },
      {
        isSubagent,
        category:
          setting.agentCategory === AgentCategory.ToolUse
            ? 'toolUse'
            : 'workflow',
        parentStreamId: options?.parentStreamId,
        onCompleted: options?.onCompleted,
      },
    );
  });
}

export async function executeMergeAgent(
  model: string,
  inputFile: string,
  editedFile: string,
  runtimeHost?: AgentRuntimeHost,
): Promise<void> {
  const host = runtimeHost ?? getAgentRuntimeHost();
  const configPayload: AgentConfigPayload = {
    agent: 'merge',
    model,
    inputFile,
    editedFile,
  };
  const ctx = await buildAgentLaunchContext({
    configPayload,
    runtimeHost: host,
    taskType: 'Merge task',
  });
  const { streamId, executionId } = ctx;

  await withExecutionRunContext(ctx, () =>
    runFlowWithLifecycle(ctx, streamId, 'merge', async () => {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
        runtimeHost: ctx.runtimeHost,
      });

      const taskStage = await logger.stage(`Task: merge@${model}`);
      return taskStage.run(async () => {
        logger.info(`Executing merge with model ${model}`);

        const fileService = new TaskRunFileService(executionId);
        const mergeSetting = ctx.setting as AgentWorkflowSetting;
        const result = await runReflectionFlow({
          ...ctx,
          ...createInterruptCallbacks(),
          onRoundFinalized: (run) =>
            ctx.usageMonitor.recordUsage(run, { runKind: 'workflow' }),
          setting: mergeSetting,
          getOutputFileLocation:
            createMergeOutputFileLocationGetter(fileService),
          parentStage: ctx.parentStage,
          onRoundCompleted: createRoundProgressCallback(
            ctx.executionId,
            streamId,
            ctx.runtimeHost,
          ),
        });
        return {
          category: 'workflow' as const,
          status: result.status,
          outputs: toOutputSummaries(result.roundOutputs),
          compileFailures: toCompileFailureSummaries(result.roundOutputs),
          executionId: ctx.executionId,
          streamId,
        };
      });
    }),
  );
}

export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  setupSession?: (session: IToolUseSession) => void,
  runtimeHost?: AgentRuntimeHost,
): Promise<void> {
  const host = runtimeHost ?? getAgentRuntimeHost();
  const ctx = await buildAgentLaunchContext({
    configPayload: snapshot.agentConfig,
    executionId: snapshot.executionId,
    runtimeHost: host,
    streamTabIdOverride: snapshot.streamId,
    // resumeCommand surfaces its own warning toast on failure; skip the
    // bus-level error to avoid double-notifying.
    suppressErrorNotification: true,
  });
  // Recover delegation depth from the persisted parent-execution chain
  // so resumed subagents remain gated by the nested-delegation policy
  // instead of silently promoting to root.
  ctx.delegationDepth = await computeDelegationDepthFromStorage(
    snapshot.executionId,
  );
  const { setting, streamId } = ctx;

  await withExecutionRunContext(ctx, async () => {
    if (setting.agentCategory !== AgentCategory.ToolUse) {
      throw new AgentError(
        'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
      );
    }

    await runFlowWithLifecycle(
      ctx,
      streamId,
      snapshot.agentConfig.agent,
      async () => {
        StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
          runtimeHost: ctx.runtimeHost,
        });

        const result = await runToolUseFlow(
          {
            ...ctx,
            ...createInterruptCallbacks(),
            onRoundFinalized: (run) =>
              ctx.usageMonitor.recordUsage(run, { runKind: 'tool-use' }),
            setting: setting as AgentToolUseSetting,
            resumeSnapshot: snapshot,
            // Derive from the recovered parent chain: any execution with a
            // parent is a subagent. Without this, the rebuilt system prompt
            // would drop subagent-specific instructions (e.g. the shared
            // /memories protocol) that the fresh run had included.
            isSubagent: (ctx.delegationDepth ?? 0) > 0,
            onFollowUpConsumed: () =>
              ctx.runtimeHost.emit('updateQueuedFollowUps', {
                streamId: ctx.streamId,
              }),
          },
          undefined,
          setupSession ? (context) => setupSession(context.session) : undefined,
        );
        return {
          category: 'toolUse' as const,
          status: result.status,
          lastResponse: result.lastResponse,
          touchedFiles: result.touchedFiles,
          executionId: ctx.executionId,
          streamId,
        };
      },
      { category: 'toolUse' },
    );
  });
}
