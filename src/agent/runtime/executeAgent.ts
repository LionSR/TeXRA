/**
 * Agent execution module - Flow-First Architecture.
 *
 * This module provides direct flow execution without agent class instantiation.
 * Flows run directly, bypassing the agent class hierarchy entirely.
 *
 * Entry points:
 * - executeAgent: Execute a new agent run
 * - resumeToolUseFromSnapshot: Resume a paused tool-use session from snapshot
 * - executeMergeAgent: Execute the merge agent (flow-first with custom file naming)
 */

// Standard library imports
import * as path from 'path';
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports - flows (primary execution path)

// Local imports - agent components (types only - no agent class instantiation)
import type { IModelHandler } from '@agent/modelHandlers';
import { resolveAgent, isRemoteAgent } from '@agent/index';
import type { ResolvedAgent } from '@agent/index';
import { createMergeOutputFileLocationGetter } from '@agent/utils/outputFileUtils';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  runToolUseFlow,
  type IToolUseSession,
} from '@agent/implementations/flows/tooluse';
import { runReflectionFlow } from '@agent/implementations/flows/reflection/runReflectionFlow';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
  AgentCategory,
  getAgentSessionDescriptor,
  type AgentWorkflowSetting,
  type AgentToolUseSetting,
} from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import {
  loadAgentSettingAndPrompts,
  ensureAgentTypeForSource,
} from '@agent/runtime/agentLoad';
import { ModelFactory } from '@agent/runtime/ModelFactory';
import { buildUserVars } from '@agent/utils/userVars';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import type {
  StreamTabId,
  ExecutionId,
  StorageKey,
  StorageKeyManager,
} from '@agent/types/IdentifierTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { normalizeRunId } from '@common/constants/runIds';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { showErrorMessage } from '@frontend/ui/messageUtils';
import { getMainWebview } from '@frontend/system/commandUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { AgentUsageReporter } from '@logger/AgentUsageReporter';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { TaskRunFileService } from '@utils/files';
import { agentConfigToTaskState } from '@utils/config';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { bus } from '@eventBus/ProgressEventBus';
import { getStreamTabId } from '@/logger/streamUtils';

import { getRunStorageService } from './RunStorageService';
import { StreamStatusService } from './StreamStatusService';
import { InterruptManager } from './InterruptManager';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

// ============================================================================
// Types
// ============================================================================

export interface AgentResolveOptions {
  preferMultiple?: boolean;
}

/**
 * Common base for flow inputs after agent resolution.
 * This is NOT passed to flows - it's used to build flow-specific inputs.
 *
 * Extends StorageKeyManager to provide storage key callbacks.
 */
interface ResolvedAgentBase extends StorageKeyManager {
  modelHandler: IModelHandler<any, any, any, any, any>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentLogger;
  streamId: StreamTabId;
  executionId: ExecutionId;
  userVarChannels: UserVariableChannels;
  usageMonitor: UsageMonitor;
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

/**
 * Options for resolveAgentBase.
 */
interface ResolveAgentOptions {
  /**
   * Override the stream tab ID for UI state.
   * Used in resume scenarios where the snapshot's stream ID should be used.
   */
  streamTabIdOverride?: StreamTabId;
}

/**
 * Resolve agent and create base dependencies for flow execution.
 * Creates all common dependencies needed by both tool-use and reflection flows.
 *
 * IMPORTANT: This function emits setActiveStream BEFORE creating the Init stage,
 * ensuring task groups appear correctly in the progress board.
 *
 * Returns base components without usage monitor - callers create flow-specific
 * usage monitors with the appropriate runKind.
 */
async function resolveAgentBase(
  agentName: string,
  configPayload: Partial<AgentConfig>,
  providedExecutionId?: ExecutionId,
  options?: ResolveAgentOptions,
): Promise<ResolvedAgentBase> {
  // Generate executionId if not provided (always a UUID)
  const executionId: ExecutionId =
    providedExecutionId ?? (randomUUID() as ExecutionId);

  // 1. Resolve agent definition
  const fullConfig = AgentConfigSchema.parse({
    agent: agentName,
    ...configPayload,
  });
  const resolution = await getAgentPath(fullConfig.agent, {
    preferMultiple: fullConfig.useMultipleOutputs,
  });
  const [loadedSettings, prompt] = await loadAgentSettingAndPrompts(
    resolution,
    { preferMultiple: fullConfig.useMultipleOutputs },
  );

  const setting = ensureAgentTypeForSource(
    loadedSettings,
    resolution.entry.source,
  );
  const sessionDescriptor = getAgentSessionDescriptor(setting);
  const agentPath = path.dirname(resolution.definitionPath);

  // 2. Validate and create model handler
  await validateAndGetModelConfig(fullConfig.model);
  const config: AgentConfig = {
    ...fullConfig,
    agentType: sessionDescriptor.agentType,
    session: sessionDescriptor,
  };
  const modelConfig = {
    ...MODEL_CONFIGS[fullConfig.model],
    toolConfig: config.toolConfig,
  };
  const modelHandler = ModelFactory.createHandler(modelConfig);

  // 3. Create execution context
  // Compute stream ID, applying override for resume scenarios
  const computedStreamTabId = getStreamTabId(
    config.agent,
    fullConfig.model,
    config.inputFile,
    {
      agentType: setting.agentType,
      executionId,
      useMultipleOutputs: config.useMultipleOutputs,
    },
  );
  // Use override if provided (resume uses snapshot's streamId)
  const streamId = options?.streamTabIdOverride ?? computedStreamTabId;

  // 3. Create logger and usage reporter directly (no AgentExecutionContext wrapper)
  const agentLogger = new AgentLogger(streamId, true);
  const usageReporter = new AgentUsageReporter(
    agentLogger,
    streamId,
    sessionDescriptor.agentCategory,
  );

  // Configure model handler with agent type and logger
  // This enables provider-specific behavior (e.g., Anthropic context management beta
  // for tool-use agents, OpenAI Response API background mode detection)
  modelHandler.setAgentType(setting.agentType);
  modelHandler.setLogger(agentLogger);

  // Emit setActiveStream BEFORE Init stage creation.
  // This ensures the frontend has state.activeStream set when addTaskGroup arrives,
  // preventing the race condition where Init groups are dropped.
  bus.emit('setActiveStream', {
    stream: streamId,
    session: sessionDescriptor,
    isRemote: isRemoteAgent(fullConfig.agent),
    hasMultipleOutputs: fullConfig.useMultipleOutputs,
  });

  // 4. Build user variable channels (replaces agent.init() logic)
  // Wrap in "Init" stage so file loading logs are properly grouped
  const initStage = await agentLogger.stage('Init');
  // Use initStage.run() to ensure buildUserVars executes within the stage's
  // group context - this makes file loading logs appear under the Init group
  const baseVars = await initStage.run(() =>
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
    ),
  );
  const userVarChannels: UserVariableChannels = {
    input: Object.freeze({ ...baseVars }),
    transient: { ...baseVars },
  };

  // 5. Define mutable storage key with callbacks
  // Initial value is executionId (normalized); workflow agents update it to task group ID
  const initialStorageKey = normalizeRunId(executionId);
  let storageKey: StorageKey = initialStorageKey;
  const getStorageKey = () => storageKey;
  const hasInitialStorageKey = () => storageKey === initialStorageKey;
  const updateStorageKey = (key: StorageKey) => {
    if (!hasInitialStorageKey()) {
      agentLogger.warn(
        `Storage key already set to ${storageKey}, updating to ${key}. This may indicate a bug.`,
      );
    }
    storageKey = key;
  };

  // 6. Create usage monitor for tracking API usage
  // Pass only the minimal model info needed (capabilities + config subset)
  const isMultipleOutput =
    setting.agentCategory === AgentCategory.Workflow
      ? (setting as AgentWorkflowSetting).isMultipleOutput
      : undefined;

  const usageMonitor = new UsageMonitor(
    {
      capabilities: modelHandler.capabilities,
      config: modelHandler.config,
    },
    {
      logger: agentLogger,
      usageReporter,
      getStorageKey,
      streamId,
    },
    {
      agentName: config.agent,
      agentCategory: setting.agentCategory,
      isMultipleOutput,
    },
  );

  return {
    modelHandler,
    config,
    setting,
    prompt,
    logger: agentLogger,
    streamId,
    executionId,
    getStorageKey,
    hasInitialStorageKey,
    updateStorageKey,
    userVarChannels,
    usageMonitor,
  };
}

// ============================================================================
// Flow Execution Helpers
// ============================================================================

/**
 * Create a usage recorder callback for flow execution.
 *
 * This callback is invoked when a round is finalized and records usage
 * statistics via the usage monitor.
 */
function createUsageRecorder(
  usageMonitor: UsageMonitor,
  runKind: 'workflow' | 'tool-use' = 'workflow',
): () => RoundFinalizedCallback {
  return () => async (run) => {
    await usageMonitor.recordUsage(run, { runKind });
  };
}

/**
 * Setup UI state for flow execution.
 *
 * Sets the stream status to RUNNING. Note: setActiveStream is emitted
 * in resolveAgentBase BEFORE Init stage creation to ensure correct
 * ordering of task group events.
 *
 * @param ctx - Resolved agent base containing execution context
 * @param streamTabIdOverride - Optional override for stream ID (used in resume scenarios
 *                              where the snapshot's stream ID should be used instead of
 *                              the regenerated one from ctx)
 */
function setupFlowUIState(
  ctx: ResolvedAgentBase,
  streamTabIdOverride?: StreamTabId,
): void {
  const streamTabId = streamTabIdOverride ?? ctx.streamId;
  StreamStatusService.set(streamTabId, STREAM_STATUS.RUNNING);
}

/**
 * Update stream status based on flow result.
 *
 * DRY helper: All flow completions need to update status, but must
 * preserve WAITING state for tool-use flows awaiting follow-up.
 */
function updateFlowStatus(
  streamTabId: StreamTabId,
  flowStatus: 'error' | 'stopped',
): void {
  const currentStatus = StreamStatusService.get(streamTabId);
  if (currentStatus !== STREAM_STATUS.WAITING) {
    StreamStatusService.set(
      streamTabId,
      flowStatus === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED,
    );
  }
}

// ============================================================================
// UI and Error Handling
// ============================================================================

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

async function logFlowError(
  errorMsg: string,
  err: unknown,
  agentName: string,
  streamId: StreamTabId,
  agentLogger: AgentLogger,
): Promise<void> {
  const errorContext = { operation: `execute ${agentName}` };
  await agentLogger.withScope(
    `Error: ${agentName}`,
    async () => agentLogger.logError(errorMsg, err, errorContext),
    { errorStatus: 'error' },
  );
}

async function handleFlowError(
  err: unknown,
  agentName: string,
  streamId: StreamTabId,
  agentLogger: AgentLogger,
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
  await logFlowError(errorMsg, err, agentName, streamId, agentLogger);

  throw new Error(errorMsg);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Execute an agent with the given configuration.
 *
 * This function runs flows directly without instantiating agent classes.
 * For resuming paused tool-use sessions, use resumeToolUseFromSnapshot instead.
 */
export async function executeAgent(
  configPayload: Partial<AgentConfig>,
  executionId?: ExecutionId,
): Promise<void> {
  if (!configPayload.model || !configPayload.agent) {
    throw new Error('Missing required fields: model and/or agent');
  }

  // Resolve agent and prepare base context
  // Wrapped in try-catch to display agent loading errors to users
  let ctx: ResolvedAgentBase;
  try {
    ctx = await resolveAgentBase(
      configPayload.agent,
      configPayload,
      executionId,
    );
  } catch (err) {
    // Show error to user unless it's a ZodError (handled by executeCommand.ts)
    if (!(err instanceof ZodError)) {
      void showErrorMessage(toErrorMessage(err));
    }
    throw err;
  }

  const { setting, streamId: streamTabId, config, logger: agentLogger } = ctx;
  const agentName = config.agent;

  if (!config.session) {
    throw new Error('Agent configuration is missing session metadata.');
  }

  // Check if already running before any state modifications
  const currentStatus = StreamStatusService.get(streamTabId);
  if (currentStatus === STREAM_STATUS.RUNNING) {
    throw new Error(
      `Task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`,
    );
  }

  try {
    if (executionId) await ensureRunDir(executionId);

    const runStorage = getRunStorageService();

    // Setup UI state
    setupFlowUIState(ctx);

    logger.info(`Starting task execution for ${streamTabId}`);
    logger.info(`Input file: ${config.inputFile}`);
    logger.debug(
      `Stream ID: ${streamTabId}, Agent: ${agentName}, Model: ${config.model}`,
    );
    logger.debug(
      `Output files: ${config.outputFiles?.length ?? 0}, useMultipleOutputs: ${config.useMultipleOutputs}`,
    );

    // Try to show progress view
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

    // Log multi-output warning
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

    // Execute the appropriate flow based on agent type
    await logger.withScope(`Task: ${agentName}@${config.model}`, async () => {
      logger.info(`Executing ${agentName} with model ${config.model}`);

      const interruptManager = new InterruptManager();
      let flowStatus: 'error' | 'stopped';

      if (setting.agentType === 'toolUse') {
        // Tool-use flow execution
        const result = await runToolUseFlow({
          ...ctx,
          ...interruptManager.asFlowInput(),
          getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
          setting: ctx.setting as AgentToolUseSetting,
        });
        flowStatus = result.status;
      } else {
        // Reflection flow execution (direct/CoT/workflow)
        const result = await runReflectionFlow({
          ...ctx,
          ...interruptManager.asFlowInput(),
          getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
          setting: ctx.setting as AgentWorkflowSetting,
        });
        flowStatus = result.status;
      }

      updateFlowStatus(streamTabId, flowStatus);
      logger.debug(`Task completed with status: ${flowStatus}`);
    });
  } catch (err) {
    StreamStatusService.set(streamTabId, STREAM_STATUS.ERROR);
    await handleFlowError(err, agentName, streamTabId, agentLogger);
  }
}

/**
 * Execute the merge agent for file merging operations.
 *
 * Uses flow-first execution with a custom output file location getter
 * for merge-specific file naming conventions.
 */
export async function executeMergeAgent(
  model: string,
  inputFile: string,
  editedFile: string,
): Promise<void> {
  // Caller (mergeCommands.ts) handles error display via showLoggedErrorMessage
  const ctx = await resolveAgentBase('merge', {
    agent: 'merge',
    model,
    inputFile,
    editedFile,
  });

  const {
    streamId: streamTabId,
    config,
    logger: agentLogger,
    executionId,
  } = ctx;

  if (!config.session) {
    throw new Error('Merge agent configuration is missing session metadata.');
  }

  // Check if already running
  const currentStatus = StreamStatusService.get(streamTabId);
  if (currentStatus === STREAM_STATUS.RUNNING) {
    throw new Error(
      `Merge task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`,
    );
  }

  try {
    setupFlowUIState(ctx);

    await logger.withScope(`Task: merge@${model}`, async () => {
      logger.info(`Executing merge with model ${model}`);

      const interruptManager = new InterruptManager();

      // Create merge-specific output file location getter
      const fileService = new TaskRunFileService(executionId);
      const getOutputFileLocation = createMergeOutputFileLocationGetter(
        inputFile,
        editedFile,
        fileService,
      );

      // Run reflection flow with custom file naming
      const result = await runReflectionFlow({
        ...ctx,
        ...interruptManager.asFlowInput(),
        getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
        setting: ctx.setting as AgentWorkflowSetting,
        getOutputFileLocation,
      });

      updateFlowStatus(streamTabId, result.status);
      logger.debug(`Task completed with status: ${result.status}`);
    });
  } catch (err) {
    StreamStatusService.set(streamTabId, STREAM_STATUS.ERROR);
    await handleFlowError(err, 'merge', streamTabId, agentLogger);
  }
}

// ============================================================================
// Tool-Use Session Resume (Flow-First)
// ============================================================================

/**
 * Resume a tool-use session from a snapshot using flow-first execution.
 *
 * This replaces the legacy agent-based resume and provides access to the
 * session interface for appending follow-up messages before execution.
 *
 * @param snapshot - The snapshot to resume from
 * @param setupSession - Optional callback to configure the session before running
 *                       (e.g., append follow-up messages)
 */
export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  setupSession?: (session: IToolUseSession) => void,
): Promise<void> {
  const snapshotConfig = snapshot.agentConfig;
  const executionId = snapshot.executionId as ExecutionId;

  // Resolve agent base with snapshot's stream ID for correct UI state
  // The streamTabIdOverride ensures ctx.streamId matches the snapshot
  // Caller (resumeCommand.ts) handles error display via showWarningMessage
  const ctx = await resolveAgentBase(
    snapshotConfig.agent,
    snapshotConfig,
    executionId,
    { streamTabIdOverride: snapshot.streamId as StreamTabId },
  );
  const { setting, streamId: streamTabId, config, logger: agentLogger } = ctx;

  // Validate agent type and session
  if (setting.agentType !== 'toolUse') {
    throw new Error(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  }

  if (!config.session) {
    throw new Error('Resume agent configuration is missing session metadata.');
  }

  const interruptManager = new InterruptManager();

  try {
    setupFlowUIState(ctx);

    // Run the flow with resume snapshot
    const result = await runToolUseFlow(
      {
        ...ctx,
        ...interruptManager.asFlowInput(),
        getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
        setting: setting as AgentToolUseSetting,
        resumeSnapshot: snapshot,
      },
      setupSession ? (context) => setupSession(context.session) : undefined,
    );

    updateFlowStatus(streamTabId, result.status);
  } catch (error) {
    StreamStatusService.set(streamTabId, STREAM_STATUS.ERROR);
    await handleFlowError(
      error,
      snapshotConfig.agent,
      streamTabId,
      agentLogger,
    );
  }
}
