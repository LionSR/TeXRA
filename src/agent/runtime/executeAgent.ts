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
  type AgentLoadOptions,
} from '@agent/runtime/agentLoad';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { buildUserVars } from '@agent/utils/userVars';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { normalizeRunId } from '@common/constants/runIds';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { bus } from '@eventBus/ProgressEventBus';
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
import { createInterruptCallbacks } from './InterruptManager';
import {
  trackExecution,
  untrackExecution,
  updateExecutionProgress,
  AgentExecutionHandle,
} from './executionRegistry';
import { generateSessionDescription } from './sessionDescription';
import { getRunStorageService } from './RunStorageService';
import type { AgentFlowResult, OutputFileSummary } from './AgentFlowResult';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

interface ResolvedAgentBase extends AgentCore {
  usageMonitor: UsageMonitor;
  storageKey: StorageKey;
  parentStage: AgentLogStage;
}

export async function getAgentPath(
  agentIdentifier: string,
  options?: AgentLoadOptions,
): Promise<ResolvedAgent> {
  const result = resolveAgent(agentIdentifier, options?.preferMultiple);
  if (result) return result;

  bus.emit('showAgentConfigBanner', { agentName: agentIdentifier });
  throw new Error(`Could not find agent: ${agentIdentifier}`);
}

async function validateModelExists(modelName: string): Promise<void> {
  if (modelName in MODEL_CONFIGS) return;

  bus.emit('requestShowInstruction', {
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
  throw new Error(`Model ${modelName} not found in MODEL_CONFIGS`);
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

interface ResolveAgentOptions {
  streamTabIdOverride?: StreamTabId;
  /** Fires after streamId is assigned but before setActiveStream is emitted. */
  onBeforeActivation?: (streamId: StreamTabId) => void;
  /** When true, reject if configPayload.agentCategory doesn't match the YAML-defined category. */
  enforceCategory?: boolean;
}

async function resolveAgentBase(
  configPayload: AgentConfigPayload,
  providedExecutionId?: ExecutionId,
  options?: ResolveAgentOptions,
): Promise<ResolvedAgentBase> {
  const executionId: ExecutionId = providedExecutionId ?? generateExecutionId();

  const fullConfig = AgentConfigSchema.parse(configPayload);
  const resolution = await getAgentPath(fullConfig.agent, {
    preferMultiple: fullConfig.useMultipleOutputs,
  });
  const [loadedSettings, prompt] = await loadAgentSettingAndPrompts(
    resolution,
    {
      preferMultiple: fullConfig.useMultipleOutputs,
    },
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
    options?.enforceCategory &&
    configPayload.agentCategory &&
    configPayload.agentCategory !== setting.agentCategory
  ) {
    const suggestion =
      setting.agentCategory === AgentCategory.ToolUse
        ? 'delegate_agent'
        : 'delegate_workflow';
    throw new Error(
      `Agent '${fullConfig.agent}' is a ${setting.agentCategory} agent but was launched as ${configPayload.agentCategory}. Use ${suggestion} instead.`,
    );
  }

  await validateModelExists(fullConfig.model);

  const useMultipleOutputs =
    fullConfig.useMultipleOutputs &&
    isWorkflowSetting(setting) &&
    setting.isMultipleOutput;
  const config: AgentConfig = {
    ...fullConfig,
    useMultipleOutputs,
    agentCategory: setting.agentCategory,
  };

  const modelHandler = createModelHandler(MODEL_CONFIGS[fullConfig.model]);

  const streamId =
    options?.streamTabIdOverride ??
    getStreamTabId(config.agent, fullConfig.model, { executionId });

  const agentLogger = new AgentLogger(streamId, true);
  const usageReporter = new AgentUsageReporter(
    agentLogger,
    streamId,
    setting.agentCategory,
  );
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  options?.onBeforeActivation?.(streamId);

  bus.emit('setActiveStream', {
    streamId,
    agentCategory: setting.agentCategory,
    isRemote: isRemoteAgent(fullConfig.agent),
    hasMultipleOutputs: useMultipleOutputs,
  });

  // Log the initial instruction as a user message so both workflow and
  // tool-use tabs display it inline with the stream log (no separate panel).
  const initialInstruction =
    config.instruction?.trim() && !options?.streamTabIdOverride
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
      isMultipleOutput: isWorkflowSetting(setting)
        ? setting.isMultipleOutput
        : undefined,
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
    workingDirectory: configPayload.workingDirectory?.trim() || undefined,
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
  taskType: string = 'Task',
): void {
  if (StreamStatusService.tryAcquire(streamId)) return;

  const status = StreamStatusService.get(streamId) ?? '';
  const statusMsg = STATUS_MESSAGES[status] || 'already running';
  throw new Error(
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

/** Create an onRoundCompleted callback that feeds progress into the execution registry and orchestrator. */
function createRoundProgressCallback(
  executionId: ExecutionId,
  streamId: StreamTabId,
  onProgress?: (update: SubagentProgressUpdate) => void,
): (roundIndex: number, totalRounds: number) => void {
  return (roundIndex, totalRounds) => {
    updateExecutionProgress(executionId, {
      currentRound: roundIndex,
      totalRounds,
    });
    onProgress?.({
      kind: 'round',
      currentRound: roundIndex,
      totalRounds,
    });
    bus.emit('updateConversationProgress', {
      streamId,
      progress: {
        conversationTurns: roundIndex + 1,
        toolCallCount: 0,
      },
    });
  };
}

async function runFlowWithLifecycle(
  ctx: ResolvedAgentBase,
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
      StreamStatusService.set(streamId, status);
    }
    logger.debug(`Task completed with status: ${result.status}`);
    return result;
  } catch (err) {
    await writeTerminalStatus(ctx.executionId, 'error').catch(() => {});
    untrackExecution(ctx.executionId);
    const errorMsg = `Error executing agent ${agentName}: ${getSdkErrorMessage(err)}`;

    // Log error BEFORE ending the group so it gets the correct groupId
    await ctx.logger.logError(errorMsg, err, {
      operation: `execute ${agentName}`,
    });

    ctx.parentStage.end(END_GROUP_STATUS.ERROR);
    StreamStatusService.set(streamId, STREAM_STATUS.ERROR);

    // Subagents propagate errors to the orchestrator via FollowUpQueue —
    // don't show VS Code popups that would confuse the user.
    if (!options?.isSubagent) {
      const msg = toErrorMessage(err);
      if (
        msg.includes('Missing API key') ||
        msg.includes('API key not found')
      ) {
        bus.emit('requestShowInstruction', {
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
      } else {
        bus.emit('requestShowError', { message: errorMsg });
      }
    }

    throw new Error(errorMsg);
  } finally {
    // Release long-lived resources (e.g., WebSocket connections, keepalive intervals)
    // to prevent leaks when handler instances are discarded after execution.
    ctx.modelHandler.dispose();
  }
}

function buildFallbackNotification(config: AgentConfig) {
  const inputName = config.inputFile
    ? path.basename(config.inputFile)
    : 'selected input';
  const { outputFiles = [], useMultipleOutputs } = config;
  const outputInfo =
    useMultipleOutputs && outputFiles.length > 1
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
 * Resolves agent context and acquires stream lock, handling the preliminary→final
 * stream ID correction that occurs when useMultipleOutputs changes during resolution.
 *
 * Consolidates the acquire → resolve → correct pattern duplicated across entry points.
 */
async function resolveAndAcquireStream(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
  options?: {
    streamTabIdOverride?: StreamTabId;
    taskType?: string;
    onBeforeActivation?: (streamId: StreamTabId) => void;
    enforceCategory?: boolean;
  },
): Promise<ResolvedAgentBase> {
  if (options?.streamTabIdOverride) {
    // Direct resolution with known stream ID (e.g., resume from snapshot)
    return resolveAgentBase(configPayload, executionId, {
      streamTabIdOverride: options.streamTabIdOverride,
      onBeforeActivation: options.onBeforeActivation,
      enforceCategory: options.enforceCategory,
    });
  }

  if (!configPayload.agent || !configPayload.model) {
    throw new Error('Missing required fields: model and/or agent');
  }
  const resolvedExecutionId = executionId ?? generateExecutionId();
  const preliminaryStreamId = getStreamTabId(
    configPayload.agent,
    configPayload.model,
    { executionId: resolvedExecutionId },
  );
  acquireStreamOrThrow(preliminaryStreamId, options?.taskType);

  let ctx: ResolvedAgentBase;
  try {
    ctx = await resolveAgentBase(configPayload, resolvedExecutionId, {
      onBeforeActivation: options?.onBeforeActivation,
      enforceCategory: options?.enforceCategory,
    });
  } catch (err) {
    StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    if (!(err instanceof ZodError)) {
      bus.emit('requestShowError', { message: toErrorMessage(err) });
    }
    throw err;
  }

  return ctx;
}

// ============================================================================
// Public Entry Points
// ============================================================================

/** Options for executeAgent. */
export interface ExecuteAgentOptions {
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
  /** Fires with the real streamId before the stream is activated (before UI sync). */
  onStreamResolved?: (streamId: StreamTabId) => void;
  /** Fires before a tool-use subagent enters WAITING, delivering interim result to orchestrator. */
  onBeforeWaiting?: (
    lastResponse: string | undefined,
    touchedFiles: string[],
  ) => void | Promise<void>;
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
  const ctx = await resolveAndAcquireStream(configPayload, executionId, {
    onBeforeActivation: options?.onStreamResolved,
    enforceCategory: options?.enforceCategory,
  });
  const { setting, streamId, config } = ctx;
  const { agent: agentName } = config;
  const { isSubagent } = options ?? {};

  // Fire-and-forget: generate AI session description from the user's instruction.
  // Triggered at the start so cancelled/errored sessions still get descriptions.
  // Applies to all agents including subagents so their progress tabs show
  // meaningful descriptions in multi-agent pipelines.
  generateSessionDescription(ctx.executionId, streamId, config).catch(() => {});
  return runFlowWithLifecycle(
    ctx,
    streamId,
    agentName,
    async () => {
      // Pre-execution UI setup
      if (executionId) await ensureRunDir(executionId);
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);
      logger.info(`Starting task execution (streamId: ${streamId})`);
      logger.info(`Input file: ${config.inputFile}`);
      logger.debug(
        `Stream ID: ${streamId}, Agent: ${config.agent}, Model: ${config.model}`,
      );
      logger.debug(
        `Output files: ${config.outputFiles?.length ?? 0}, useMultipleOutputs: ${config.useMultipleOutputs}`,
      );
      // Subagents don't need to force-open the progress board or show notifications —
      // the orchestrator's stream is already visible.
      if (!isSubagent && !getRunStorageService().isViewVisible()) {
        bus.emit('requestEnsureProgressView', {
          fallbackNotification: buildFallbackNotification(config),
        });
      }
      bus.emit('setTaskState', {
        streamId,
        executionId,
        taskState: agentConfigToTaskState(config),
      });
      if (config.outputFiles.length > 1 && !config.useMultipleOutputs) {
        logger.warn(
          `Multiple output files provided (${config.outputFiles.length}) but useMultipleOutputs flag is disabled.`,
        );
      }

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
                bus.emit('updateConversationProgress', {
                  streamId,
                  progress: {
                    conversationTurns: toolUseTurns,
                    toolCallCount: update.toolCallCount,
                  },
                });
              }
              options?.onProgress?.(update);
            },
            onFollowUpConsumed: () =>
              bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
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
}

export async function executeMergeAgent(
  model: string,
  inputFile: string,
  editedFile: string,
): Promise<void> {
  const configPayload: AgentConfigPayload = {
    agent: 'merge',
    model,
    inputFile,
    editedFile,
  };
  const ctx = await resolveAndAcquireStream(configPayload, undefined, {
    taskType: 'Merge task',
  });
  const { streamId, executionId } = ctx;

  await runFlowWithLifecycle(ctx, streamId, 'merge', async () => {
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);

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
        getOutputFileLocation: createMergeOutputFileLocationGetter(
          fileService,
          mergeSetting.outputExt,
        ),
        parentStage: ctx.parentStage,
        onRoundCompleted: createRoundProgressCallback(
          ctx.executionId,
          streamId,
        ),
      });
      return {
        category: 'workflow' as const,
        status: result.status,
        outputs: toOutputSummaries(result.roundOutputs),
        executionId: ctx.executionId,
        streamId,
      };
    });
  });
}

export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  setupSession?: (session: IToolUseSession) => void,
): Promise<void> {
  const ctx = await resolveAndAcquireStream(
    snapshot.agentConfig,
    snapshot.executionId,
    { streamTabIdOverride: snapshot.streamId },
  );
  const { setting, streamId } = ctx;

  if (setting.agentCategory !== AgentCategory.ToolUse) {
    throw new Error(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  }

  await runFlowWithLifecycle(
    ctx,
    streamId,
    snapshot.agentConfig.agent,
    async () => {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);

      const result = await runToolUseFlow(
        {
          ...ctx,
          ...createInterruptCallbacks(),
          onRoundFinalized: (run) =>
            ctx.usageMonitor.recordUsage(run, { runKind: 'tool-use' }),
          setting: setting as AgentToolUseSetting,
          resumeSnapshot: snapshot,
          onFollowUpConsumed: () =>
            bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
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
}
