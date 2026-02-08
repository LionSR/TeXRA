import * as path from 'path';
import { randomUUID } from 'crypto';

import * as vscode from 'vscode';
import { ZodError } from 'zod';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  STREAM_STATUS,
  END_GROUP_STATUS,
  type EndGroupStatus,
  type StreamTabId,
  type ExecutionId,
  type StorageKey,
  type OutputFileInfo,
  type RoundOutput,
} from '@shared/schemas';
import {
  resolveAgent,
  isRemoteAgent,
  getAgent,
  type ResolvedAgent,
} from '@agent/index';
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
import { normalizeRunId } from '@common/constants/runIds';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { getMainWebview } from '@frontend/system/commandUtils';
import {
  AgentLogger,
  AgentUsageReporter,
  getStreamTabId,
  type AgentLogStage,
} from '@logger/index';
import { TaskRunFileService } from '@utils/files';
import { agentConfigToTaskState } from '@utils/config/configConversion';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { bus } from '@eventBus/ProgressEventBus';

import { getRunStorageService } from './RunStorageService';
import { StreamStatusService } from './StreamStatusService';
import { createInterruptCallbacks } from './InterruptManager';
import type { AgentFlowResult, OutputFileSummary } from './AgentFlowResult';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

interface ResolvedAgentBase extends AgentCore {
  usageMonitor: UsageMonitor;
  storageKey: StorageKey;
  parentStage: AgentLogStage;
}

function computePreliminaryStreamId(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
): StreamTabId {
  if (!configPayload.agent || !configPayload.model) {
    throw new Error('Missing required fields: model and/or agent');
  }

  const agentEntry = getAgent(configPayload.agent);
  const agentCategory = agentEntry?.category ?? AgentCategory.Workflow;

  return getStreamTabId(
    configPayload.agent,
    configPayload.model,
    configPayload.inputFile ?? '',
    {
      agentCategory,
      executionId,
      useMultipleOutputs: configPayload.useMultipleOutputs,
    },
  );
}

export async function getAgentPath(
  agentIdentifier: string,
  options?: AgentLoadOptions,
): Promise<ResolvedAgent> {
  const result = resolveAgent(agentIdentifier, options?.preferMultiple);
  if (result) return result;

  const view = await getMainWebview(CHANNEL);
  view?.webview.postMessage({
    command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
    agentName: agentIdentifier,
    customDirSet: true,
  });
  throw new Error(`Could not find agent: ${agentIdentifier}`);
}

async function validateAndGetModelConfig(modelName: string): Promise<void> {
  if (modelName in MODEL_CONFIGS) return;

  await showInstructionWithSuppress(
    'modelNotRecognized',
    `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
    [
      {
        title: 'Model Documentation',
        callback: () =>
          void vscode.commands.executeCommand('texra.openDoc', 'models'),
      },
    ],
    false,
  );
  throw new Error(`Model ${modelName} not found in MODEL_CONFIGS`);
}

interface ResolveAgentOptions {
  streamTabIdOverride?: StreamTabId;
}

async function resolveAgentBase(
  configPayload: AgentConfigPayload,
  providedExecutionId?: ExecutionId,
  options?: ResolveAgentOptions,
): Promise<ResolvedAgentBase> {
  const executionId: ExecutionId =
    providedExecutionId ?? (randomUUID() as ExecutionId);

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

  await validateAndGetModelConfig(fullConfig.model);

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
    getStreamTabId(config.agent, fullConfig.model, config.inputFile, {
      agentCategory: setting.agentCategory,
      executionId,
      useMultipleOutputs,
    });

  const agentLogger = new AgentLogger(streamId, true);
  const usageReporter = new AgentUsageReporter(
    agentLogger,
    streamId,
    setting.agentCategory,
  );
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  bus.emit('setActiveStream', {
    streamId,
    agentCategory: setting.agentCategory,
    isRemote: isRemoteAgent(fullConfig.agent),
    hasMultipleOutputs: useMultipleOutputs,
  });

  const parentStage = await agentLogger.stage(`Run: ${config.agent}`);
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

function isApiKeyError(err: unknown): boolean {
  const msg = toErrorMessage(err);
  return msg.includes('Missing API key') || msg.includes('API key not found');
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

async function runFlowWithLifecycle(
  ctx: ResolvedAgentBase,
  streamId: StreamTabId,
  agentName: string,
  runner: () => Promise<AgentFlowResult>,
): Promise<AgentFlowResult> {
  try {
    const result = await runner();
    ctx.parentStage.end(result.status);

    if (!StreamStatusService.shouldPreserveOnCompletion(streamId)) {
      const status =
        result.status === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED;
      StreamStatusService.set(streamId, status);
    }
    logger.debug(`Task completed with status: ${result.status}`);
    return result;
  } catch (err) {
    const errorMsg = `Error executing agent ${agentName}: ${getSdkErrorMessage(err)}`;

    // Log error BEFORE ending the group so it gets the correct groupId
    await ctx.logger.logError(errorMsg, err, {
      operation: `execute ${agentName}`,
    });

    ctx.parentStage.end(END_GROUP_STATUS.ERROR);
    StreamStatusService.set(streamId, STREAM_STATUS.ERROR);

    if (isApiKeyError(err)) {
      await showApiKeyErrorNotification();
    } else {
      vscode.window.showErrorMessage(errorMsg);
    }

    throw new Error(errorMsg);
  }
}

function getOutputInfo(config: AgentConfig): string {
  const { outputFiles = [], useMultipleOutputs } = config;
  if (useMultipleOutputs && outputFiles.length > 1) {
    return `to ${outputFiles.length} files`;
  }
  const firstOutput = outputFiles[0];
  return firstOutput ? `to ${path.basename(firstOutput)}` : '';
}

async function showAgentNotification(config: AgentConfig): Promise<void> {
  const inputName = config.inputFile
    ? path.basename(config.inputFile)
    : 'selected input';
  const outputInfo = getOutputInfo(config);

  const selection = await vscode.window.showInformationMessage(
    `TeXRA Agent Started: "${config.agent}" is processing ${inputName} with ${config.model} ${outputInfo}. View in ProgressBoard for progress.`,
    {
      modal: false,
      detail:
        'TeXRA agents run in the background and their progress can be tracked in the ProgressBoard.',
    },
    'Show ProgressBoard',
  );
  if (selection) {
    await vscode.commands.executeCommand('texra.showProgressView');
  }
}

async function showApiKeyErrorNotification(): Promise<void> {
  await showInstructionWithSuppress(
    'missingApiKey',
    'API key not found. Set your API key in the extension settings and run again.',
    [
      {
        title: 'Set API Key',
        callback: () => void vscode.commands.executeCommand('texra.setApiKey'),
      },
      {
        title: 'Open Settings Guide',
        callback: () =>
          void vscode.commands.executeCommand('texra.openDoc', 'configuration'),
      },
    ],
    false,
  );
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
  },
): Promise<ResolvedAgentBase> {
  if (options?.streamTabIdOverride) {
    // Direct resolution with known stream ID (e.g., resume from snapshot)
    return resolveAgentBase(configPayload, executionId, {
      streamTabIdOverride: options.streamTabIdOverride,
    });
  }

  const preliminaryStreamId = computePreliminaryStreamId(
    configPayload,
    executionId,
  );
  acquireStreamOrThrow(preliminaryStreamId, options?.taskType);

  let ctx: ResolvedAgentBase;
  try {
    ctx = await resolveAgentBase(configPayload, executionId);
  } catch (err) {
    StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    if (!(err instanceof ZodError)) {
      void vscode.window.showErrorMessage(toErrorMessage(err));
    }
    throw err;
  }

  // Stream ID may change when useMultipleOutputs is resolved from agent settings
  if (ctx.streamId !== preliminaryStreamId) {
    logger.debug(
      `Stream ID changed: preliminary=${preliminaryStreamId}, resolved=${ctx.streamId}. ` +
        'Corrected useMultipleOutputs based on agent support.',
    );
    StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    try {
      acquireStreamOrThrow(ctx.streamId);
    } catch (err) {
      ctx.parentStage.end(END_GROUP_STATUS.ERROR);
      throw err;
    }
  }

  return ctx;
}

/** Creates a flow context with interrupt callbacks and a usage recorder for the given flow kind. */
function createFlowContext(
  ctx: ResolvedAgentBase,
  runKind: 'workflow' | 'tool-use',
) {
  return {
    ...ctx,
    ...createInterruptCallbacks(),
    getUsageRecorder: () => (run: Parameters<UsageMonitor['recordUsage']>[0]) =>
      ctx.usageMonitor.recordUsage(run, { runKind }),
  };
}

/** Pre-execution UI setup: progress board visibility, notifications, task state emission. */
async function prepareAgentUI(
  ctx: ResolvedAgentBase,
  executionId: ExecutionId | undefined,
): Promise<void> {
  if (executionId) await ensureRunDir(executionId);
  const { streamId, config } = ctx;
  const agentName = config.agent;

  const runStorage = getRunStorageService();
  StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);

  logger.info(`Starting task execution for ${streamId}`);
  logger.info(`Input file: ${config.inputFile}`);
  logger.debug(
    `Stream ID: ${streamId}, Agent: ${agentName}, Model: ${config.model}`,
  );
  logger.debug(
    `Output files: ${config.outputFiles?.length ?? 0}, useMultipleOutputs: ${config.useMultipleOutputs}`,
  );

  if (!runStorage.isViewVisible()) {
    await vscode.commands.executeCommand('texra.showProgressView');
  }
  if (!runStorage.isViewVisible()) {
    showAgentNotification(config);
  }
  bus.emit('setTaskState', {
    streamId,
    executionId,
    taskState: agentConfigToTaskState(config),
  });

  const { outputFiles, useMultipleOutputs } = config;
  if (
    Array.isArray(outputFiles) &&
    outputFiles.length > 1 &&
    !useMultipleOutputs
  ) {
    logger.warn(
      `Multiple output files provided (${outputFiles.length}) but useMultipleOutputs flag is disabled.`,
    );
  }
}

// ============================================================================
// Public Entry Points
// ============================================================================

/** Options for executeAgent. */
export interface ExecuteAgentOptions {
  /** When true, proposal tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
  /** Fires early with the real streamId, before flow execution starts. */
  onStreamResolved?: (streamId: StreamTabId) => void;
}

export async function executeAgent(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
  options?: ExecuteAgentOptions,
): Promise<AgentFlowResult> {
  if (!configPayload.model || !configPayload.agent) {
    throw new Error('Missing required fields: model and/or agent');
  }

  const ctx = await resolveAndAcquireStream(configPayload, executionId);
  const { setting, streamId, config } = ctx;
  const agentName = config.agent;

  options?.onStreamResolved?.(streamId);

  return runFlowWithLifecycle(ctx, streamId, agentName, async () => {
    await prepareAgentUI(ctx, executionId);

    const taskStage = await logger.stage(`Task: ${agentName}@${config.model}`);
    return taskStage.run(async () => {
      logger.info(`Executing ${agentName} with model ${config.model}`);

      if (setting.agentCategory === AgentCategory.ToolUse) {
        const flowContext = createFlowContext(ctx, 'tool-use');
        const result = await runToolUseFlow({
          ...flowContext,
          setting: ctx.setting as AgentToolUseSetting,
          isSubagent: options?.isSubagent,
          onFollowUpConsumed: () =>
            bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
        });
        return {
          category: 'toolUse' as const,
          status: result.status,
          lastResponse: result.lastResponse,
          streamId,
        };
      }

      const flowContext = createFlowContext(ctx, 'workflow');
      const result = await runReflectionFlow({
        ...flowContext,
        setting: ctx.setting as AgentWorkflowSetting,
        parentStage: ctx.parentStage,
      });
      return {
        category: 'workflow' as const,
        status: result.status,
        outputs: toOutputSummaries(result.roundOutputs),
        streamId,
      };
    });
  });
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
      const flowContext = createFlowContext(ctx, 'workflow');
      const result = await runReflectionFlow({
        ...flowContext,
        setting: ctx.setting as AgentWorkflowSetting,
        getOutputFileLocation: createMergeOutputFileLocationGetter(
          inputFile,
          editedFile,
          fileService,
        ),
        parentStage: ctx.parentStage,
      });
      return {
        category: 'workflow' as const,
        status: result.status,
        outputs: toOutputSummaries(result.roundOutputs),
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

      const flowContext = createFlowContext(ctx, 'tool-use');
      const result = await runToolUseFlow(
        {
          ...flowContext,
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
        streamId,
      };
    },
  );
}
