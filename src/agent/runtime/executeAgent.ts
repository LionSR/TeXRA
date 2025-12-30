/**
 * Agent execution module.
 *
 * Provides entry points for executing agents:
 * - executeAgent: Execute a new agent run
 * - resumeAgentExecution: Resume a paused agent run
 * - executeMergeAgent: Execute the merge agent
 * - runPreparedAgent: Run a pre-configured agent instance
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import {
  DirectAgent,
  CoTAgent,
  MergeAgent,
  BaseToolUseAgent,
  BaseReflectionAgent,
} from '@agent/implementations';
import { resolveAgent, isRemoteAgent } from '@agent/index';
import type { ResolvedAgent } from '@agent/index';
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
  getAgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
import { IAgent } from '@agent/core/IAgent';
import {
  loadAgentSettingAndPrompts,
  ensureAgentTypeForSource,
} from '@agent/runtime/agentLoad';
import { ModelFactory } from '@agent/runtime/ModelFactory';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { normalizeRunId } from '@common/constants/runIds';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { getMainWebview } from '@frontend/system/commandUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { agentConfigToTaskState } from '@utils/config';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { bus } from '@eventBus/ProgressEventBus';
import { getStreamTabId } from '@/logger/streamUtils';

import { getRunStorageService } from './RunStorageService';
import { StreamStatusService } from './StreamStatusService';
import {
  AgentExecutionContext,
  type AgentExecutionContextInit,
} from './AgentExecutionContext';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

// ============================================================================
// Types
// ============================================================================

type AgentConstructor = {
  new (
    modelHandler: any,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    context: AgentExecutionContext,
  ): IAgent;
};

export interface AgentResolveOptions {
  preferMultiple?: boolean;
}

interface PrepareAgentInstanceParams {
  agentName: string;
  configPayload: Partial<AgentConfig>;
  executionId?: ExecutionId;
  agentClassOverride?: AgentConstructor;
}

export interface ExecuteAgentOptions {
  resume?: boolean;
}

export interface RunPreparedAgentOptions {
  isResume?: boolean;
  executionId?: ExecutionId;
}

// ============================================================================
// Agent Resolution & Preparation
// ============================================================================

export async function getAgentPath(
  agentIdentifier: string,
  options?: AgentResolveOptions,
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

function getAgentClass(settings: AgentSetting): AgentConstructor {
  const mapping: Record<string, AgentConstructor> = {
    direct: DirectAgent,
    CoT: CoTAgent,
    toolUse: BaseToolUseAgent,
  };
  return mapping[settings.agentType] || DirectAgent;
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

function createModelHandler(
  modelName: string,
  toolConfig: AgentConfig['toolConfig'],
) {
  const baseConfig = MODEL_CONFIGS[modelName];
  const modelConfig = { ...baseConfig, toolConfig };
  return ModelFactory.createHandler(modelConfig);
}

export async function prepareAgentInstance<T extends IAgent = IAgent>(
  params: PrepareAgentInstanceParams,
): Promise<{ agent: T; agentType: AgentType; context: AgentExecutionContext }> {
  const { agentName, configPayload, executionId, agentClassOverride } = params;

  // 1. Resolve agent definition
  const fullConfig = parseAgentConfig({ agent: agentName, ...configPayload });
  const resolution = await getAgentPath(fullConfig.agent, {
    preferMultiple: fullConfig.useMultipleOutputs,
  });
  const [loadedSettings, agentPrompt] = await loadAgentSettingAndPrompts(
    resolution,
    { preferMultiple: fullConfig.useMultipleOutputs },
  );

  const agentSetting = ensureAgentTypeForSource(
    loadedSettings,
    resolution.entry.source,
  );
  const sessionDescriptor = getAgentSessionDescriptor(agentSetting);

  // 2. Validate and create model handler
  await validateAndGetModelConfig(fullConfig.model);
  const agentConfig: AgentConfig = {
    ...fullConfig,
    agentType: sessionDescriptor.agentType,
    session: sessionDescriptor,
  };
  const modelHandler = createModelHandler(
    fullConfig.model,
    agentConfig.toolConfig,
  );

  // 3. Create execution context
  const streamId = getStreamTabId(
    agentConfig.agent,
    fullConfig.model,
    agentConfig.inputFile,
    {
      agentType: agentSetting.agentType,
      executionId,
      useMultipleOutputs: agentConfig.useMultipleOutputs,
    },
  );
  const context = new AgentExecutionContext({
    streamId,
    executionId,
    agentCategory: sessionDescriptor.agentCategory,
  });

  // 4. Instantiate agent
  const AgentClass = (agentClassOverride ??
    getAgentClass(agentSetting)) as AgentConstructor;
  const agent = new AgentClass(
    modelHandler,
    agentConfig,
    agentSetting,
    agentPrompt,
    path.dirname(resolution.definitionPath),
    context,
  );

  return { agent: agent as T, agentType: agentSetting.agentType, context };
}

// ============================================================================
// Core Execution
// ============================================================================

/**
 * Run a prepared agent instance. This is the core execution function.
 */
export async function runPreparedAgent<T extends IAgent>(
  agent: T,
  context: AgentExecutionContext,
  options?: RunPreparedAgentOptions,
): Promise<void> {
  const isResume = options?.isResume ?? false;
  const executionId = options?.executionId;
  const config = agent.config;
  const streamTabId = agent.getStreamTabId();
  const agentName = config.agent;

  if (!config.session)
    throw new Error('Agent configuration is missing session metadata.');
  if (!streamTabId)
    throw new Error('Failed to resolve stream tab ID for agent execution');

  try {
    if (executionId) await ensureRunDir(executionId);

    const runStorage = getRunStorageService();

    // Setup UI state
    bus.emit('setActiveStream', {
      stream: streamTabId,
      session: config.session,
      isRemote: isRemoteAgent(config.agent),
      hasMultipleOutputs: config.useMultipleOutputs,
    });
    StreamStatusService.set(streamTabId, STREAM_STATUS.RUNNING);

    if (!isResume) {
      logger.info(`Starting task execution for ${streamTabId}`);
      logger.info(`Input file: ${config.inputFile}`);
      logger.debug(
        `Stream ID: ${streamTabId}, Agent: ${agentName}, Model: ${config.model}`,
      );
      logger.debug(
        `Output files: ${config.outputFiles?.length ?? 0}, useMultipleOutputs: ${config.useMultipleOutputs}`,
      );

      // Try to show progress view; if still not visible (e.g., user has it hidden),
      // fall back to showing a notification so user knows the task started
      if (!runStorage.isViewVisible()) {
        await vscode.commands.executeCommand('texra.showProgressView');
      }
      if (!runStorage.isViewVisible()) {
        showAgentNotification(config);
      }
      bus.emit('setTaskState', {
        streamTabId,
        executionId,
        taskState: agentConfigToTaskState(config),
      });
    }

    // Run agent
    await logger.withScope(
      `Task: ${agentName}@${config.model}`,
      async () => {
        logger.info(`Executing ${agentName} with model ${config.model}`);
        await agent.run();
        logger.debug(`Task completed successfully`);
        StreamStatusService.set(streamTabId, STREAM_STATUS.STOPPED);
      },
      { skip: isResume },
    );
  } catch (err) {
    StreamStatusService.set(streamTabId, STREAM_STATUS.ERROR);
    await handleError(err, agentName, streamTabId, agent, context); // always throws
  }
}

function showAgentNotification(config: AgentConfig): void {
  const inputName = config.inputFile
    ? path.basename(config.inputFile)
    : 'selected input';
  const outputInfo =
    config.useMultipleOutputs && (config.outputFiles?.length ?? 0) > 1
      ? `to ${config.outputFiles!.length} files`
      : config.outputFiles?.[0]
        ? `to ${path.basename(config.outputFiles[0])}`
        : '';

  vscode.window
    .showInformationMessage(
      `TeXRA Agent Started: "${config.agent}" is processing ${inputName} with ${config.model} ${outputInfo}. View in ProgressBoard for progress.`,
      {
        modal: false,
        detail:
          'TeXRA agents run in the background and their progress can be tracked in the ProgressBoard.',
      },
      'Show ProgressBoard',
    )
    .then((sel: string | undefined) => {
      if (sel) void vscode.commands.executeCommand('texra.showProgressView');
    });
}

function isApiKeyError(errorMessage: string): boolean {
  return (
    errorMessage.includes('Missing API key') ||
    errorMessage.includes('API key not found')
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

async function logAgentError(
  errorMsg: string,
  err: unknown,
  agentName: string,
  streamId: StreamTabId,
  agent?: IAgent,
  context?: AgentExecutionContext,
): Promise<void> {
  const errorLogger = context?.logger ?? new AgentLogger(streamId, true);
  const errorContext = { operation: `execute ${agentName}` };
  const groupId = agent?.getLastRunGroupId();

  if (groupId && context?.logger) {
    await errorLogger.withExistingGroup(
      groupId,
      async () => errorLogger.logError(errorMsg, err, errorContext),
      { label: `Error: ${agentName}` },
    );
  } else {
    await errorLogger.withScope(
      `Error: ${agentName}`,
      async () => errorLogger.logError(errorMsg, err, errorContext),
      { errorStatus: 'error' },
    );
  }
}

async function handleError(
  err: unknown,
  agentName: string,
  streamId: StreamTabId,
  agent?: IAgent,
  context?: AgentExecutionContext,
): Promise<never> {
  const rawMsg = toErrorMessage(err);
  const errorMsg = `Error executing agent ${agentName}: ${getSdkErrorMessage(err)}`;

  // Show appropriate notification
  if (isApiKeyError(rawMsg)) {
    await showApiKeyErrorNotification();
  } else {
    vscode.window.showErrorMessage(errorMsg);
  }

  // Log with proper grouping
  await logAgentError(errorMsg, err, agentName, streamId, agent, context);

  throw new Error(errorMsg);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Execute an agent with the provided configuration.
 */
export async function executeAgent(
  agentConfig: Partial<AgentConfig>,
  executionId?: ExecutionId,
  options?: ExecuteAgentOptions,
): Promise<void> {
  if (!agentConfig.model || !agentConfig.agent) {
    throw new Error('Missing required fields: model and/or agent');
  }

  const isResume = options?.resume ?? false;

  const { agent, context } = await prepareAgentInstance({
    agentName: agentConfig.agent,
    configPayload: agentConfig,
    executionId,
  });

  const streamTabId = agent.getStreamTabId();

  // Check if already running before any state modifications
  // Note: Allow resume even when status is RUNNING to recover from crashed tasks
  // that didn't properly transition to ERROR status
  const currentStatus = StreamStatusService.get(streamTabId);
  if (!isResume && currentStatus === STREAM_STATUS.RUNNING) {
    throw new Error(
      `Task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`,
    );
  }
  if (isResume && currentStatus === STREAM_STATUS.RESUMING) {
    throw new Error(`Task "${streamTabId}" is already being resumed.`);
  }

  // Prepare resume for reflection agents (hydration happens in startAndInitRun)
  if (isResume && agent instanceof BaseReflectionAgent && executionId) {
    StreamStatusService.set(streamTabId, STREAM_STATUS.RESUMING);
    const runStorage = getRunStorageService();
    const activeRunId = runStorage.getActiveRunId(streamTabId);
    const storageKey = normalizeRunId(activeRunId ?? executionId);
    const runOutputs = runStorage.getRunOutputFiles(streamTabId, {
      storageKey,
    });
    if (runOutputs) {
      // Synchronous setup - actual hydration happens in agent.startAndInitRun()
      agent.prepareResume({
        executionId,
        storageKey,
        rounds: runOutputs,
      });
    }
  }

  // Log multi-output warning
  const { outputFiles, useMultipleOutputs } = agent.config;
  if (
    Array.isArray(outputFiles) &&
    outputFiles.length > 1 &&
    !useMultipleOutputs
  ) {
    logger.warn(
      `Multiple output files provided (${outputFiles.length}) but useMultipleOutputs flag is disabled.`,
    );
  }

  await runPreparedAgent(agent, context, { isResume, executionId });
}

/**
 * Resume a paused agent execution.
 */
export async function resumeAgentExecution(
  agentConfig: Partial<AgentConfig>,
  executionId: ExecutionId,
): Promise<void> {
  if (!executionId) throw new Error('Cannot resume without an execution ID.');
  await executeAgent(agentConfig, executionId, { resume: true });
}

/**
 * Execute the merge agent for file merging operations.
 */
export async function executeMergeAgent(
  model: string,
  inputFile: string,
  editedFile: string,
): Promise<void> {
  const { agent, context } = await prepareAgentInstance<MergeAgent>({
    agentName: 'merge',
    configPayload: { agent: 'merge', model, inputFile, editedFile },
    agentClassOverride: MergeAgent,
  });

  // Check if already running before execution (same protection as executeAgent)
  const streamTabId = agent.getStreamTabId();
  const currentStatus = StreamStatusService.get(streamTabId);
  if (currentStatus === STREAM_STATUS.RUNNING) {
    throw new Error(
      `Merge task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`,
    );
  }

  await runPreparedAgent(agent, context);
}
