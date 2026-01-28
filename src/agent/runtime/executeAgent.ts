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

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

/**
 * Creates a usage recorder callback for flows.
 * Wraps UsageMonitor.recordUsage with the appropriate run kind.
 */
function createUsageRecorder(
  usageMonitor: UsageMonitor,
  runKind: 'workflow' | 'tool-use',
): () => (run: Parameters<UsageMonitor['recordUsage']>[0]) => Promise<void> {
  return () => (run) => usageMonitor.recordUsage(run, { runKind });
}

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

async function runFlowWithLifecycle(
  ctx: ResolvedAgentBase,
  streamId: StreamTabId,
  agentName: string,
  runner: () => Promise<EndGroupStatus>,
): Promise<void> {
  try {
    const flowStatus = await runner();
    ctx.parentStage.end(flowStatus);

    if (!StreamStatusService.shouldPreserveOnCompletion(streamId)) {
      const status =
        flowStatus === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED;
      StreamStatusService.set(streamId, status);
    }
    logger.debug(`Task completed with status: ${flowStatus}`);
  } catch (err) {
    ctx.parentStage.end(END_GROUP_STATUS.ERROR);
    StreamStatusService.set(streamId, STREAM_STATUS.ERROR);

    const errorMsg = `Error executing agent ${agentName}: ${getSdkErrorMessage(err)}`;

    if (isApiKeyError(err)) {
      await showApiKeyErrorNotification();
    } else {
      vscode.window.showErrorMessage(errorMsg);
    }

    await ctx.logger.logError(errorMsg, err, {
      operation: `execute ${agentName}`,
    });

    throw new Error(errorMsg);
  }
}

function getOutputInfo(config: AgentConfig): string {
  const outputFiles = config.outputFiles ?? [];
  if (config.useMultipleOutputs && outputFiles.length > 1) {
    return `to ${outputFiles.length} files`;
  }
  if (outputFiles[0]) {
    return `to ${path.basename(outputFiles[0])}`;
  }
  return '';
}

function showAgentNotification(config: AgentConfig): void {
  const inputName = config.inputFile
    ? path.basename(config.inputFile)
    : 'selected input';
  const outputInfo = getOutputInfo(config);

  void vscode.window
    .showInformationMessage(
      `TeXRA Agent Started: "${config.agent}" is processing ${inputName} with ${config.model} ${outputInfo}. View in ProgressBoard for progress.`,
      {
        modal: false,
        detail:
          'TeXRA agents run in the background and their progress can be tracked in the ProgressBoard.',
      },
      'Show ProgressBoard',
    )
    .then(
      (sel) => sel && vscode.commands.executeCommand('texra.showProgressView'),
    );
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

export async function executeAgent(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
): Promise<void> {
  if (!configPayload.model || !configPayload.agent) {
    throw new Error('Missing required fields: model and/or agent');
  }

  const preliminaryStreamId = computePreliminaryStreamId(
    configPayload,
    executionId,
  );
  acquireStreamOrThrow(preliminaryStreamId);

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

  const { setting, streamId, config } = ctx;
  const agentName = config.agent;

  if (streamId !== preliminaryStreamId) {
    logger.debug(
      `Stream ID changed: preliminary=${preliminaryStreamId}, resolved=${streamId}. ` +
        'Corrected useMultipleOutputs based on agent support.',
    );
    StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    try {
      acquireStreamOrThrow(streamId);
    } catch (err) {
      ctx.parentStage.end(END_GROUP_STATUS.ERROR);
      throw err;
    }
  }

  await runFlowWithLifecycle(ctx, streamId, agentName, async () => {
    if (executionId) await ensureRunDir(executionId);

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

    const taskStage = await logger.stage(`Task: ${agentName}@${config.model}`);
    return taskStage.run(async () => {
      logger.info(`Executing ${agentName} with model ${config.model}`);

      const interruptCallbacks = createInterruptCallbacks();

      const flowContext = {
        ...ctx,
        ...interruptCallbacks,
      };

      if (setting.agentCategory === AgentCategory.ToolUse) {
        const result = await runToolUseFlow({
          ...flowContext,
          getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
          setting: ctx.setting as AgentToolUseSetting,
          onFollowUpConsumed: () =>
            bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
        });
        return result.status;
      }

      const result = await runReflectionFlow({
        ...flowContext,
        getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
        setting: ctx.setting as AgentWorkflowSetting,
        parentStage: ctx.parentStage,
      });
      return result.status;
    });
  });
}

export async function executeMergeAgent(
  model: string,
  inputFile: string,
  editedFile: string,
): Promise<void> {
  const preliminaryStreamId = computePreliminaryStreamId({
    agent: 'merge',
    model,
    inputFile,
  });
  acquireStreamOrThrow(preliminaryStreamId, 'Merge task');

  let ctx: ResolvedAgentBase;
  let resolutionSucceeded = false;
  try {
    ctx = await resolveAgentBase({
      agent: 'merge',
      model,
      inputFile,
      editedFile,
    });
    resolutionSucceeded = true;
  } finally {
    if (!resolutionSucceeded) {
      StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    }
  }

  const { streamId, config, executionId } = ctx;

  await runFlowWithLifecycle(ctx, streamId, 'merge', async () => {
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);

    const taskStage = await logger.stage(`Task: merge@${model}`);
    return taskStage.run(async () => {
      logger.info(`Executing merge with model ${model}`);

      const fileService = new TaskRunFileService(executionId);
      const getOutputFileLocation = createMergeOutputFileLocationGetter(
        inputFile,
        editedFile,
        fileService,
      );

      const result = await runReflectionFlow({
        ...ctx,
        ...createInterruptCallbacks(),
        getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
        setting: ctx.setting as AgentWorkflowSetting,
        getOutputFileLocation,
        parentStage: ctx.parentStage,
      });
      return result.status;
    });
  });
}

export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  setupSession?: (session: IToolUseSession) => void,
): Promise<void> {
  const ctx = await resolveAgentBase(
    snapshot.agentConfig,
    snapshot.executionId,
    {
      streamTabIdOverride: snapshot.streamId,
    },
  );
  const { setting, streamId } = ctx;

  if (setting.agentCategory !== AgentCategory.ToolUse) {
    throw new Error(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  }

  const flowContext = {
    ...ctx,
    ...createInterruptCallbacks(),
  };

  await runFlowWithLifecycle(
    ctx,
    streamId,
    snapshot.agentConfig.agent,
    async () => {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);

      const result = await runToolUseFlow(
        {
          ...flowContext,
          getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
          setting: setting as AgentToolUseSetting,
          resumeSnapshot: snapshot,
          onFollowUpConsumed: () =>
            bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
        },
        undefined, // use default tool registry
        setupSession ? (context) => setupSession(context.session) : undefined,
      );
      return result.status;
    },
  );
}
