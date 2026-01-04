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
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { normalizeRunId } from '@common/constants/runIds';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { showErrorMessage } from '@frontend/ui/messageUtils';
import { getMainWebview } from '@frontend/system/commandUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { TaskRunFileService } from '@utils/files';
import { agentConfigToTaskState } from '@utils/config';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { bus } from '@eventBus/ProgressEventBus';
import { getStreamTabId } from '@/logger/streamUtils';

import { getRunStorageService } from './RunStorageService';
import { StreamStatusService } from './StreamStatusService';
import { InterruptManager } from './InterruptManager';
import { AgentExecutionContext } from './AgentExecutionContext';

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
 */
interface ResolvedAgentBase {
  modelHandler: IModelHandler<any, any, any, any, any>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  executionContext: AgentExecutionContext;
  streamTabId: StreamTabId;
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
  executionId?: ExecutionId,
  options?: ResolveAgentOptions,
): Promise<ResolvedAgentBase> {
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
  const streamTabId = getStreamTabId(
    config.agent,
    fullConfig.model,
    config.inputFile,
    {
      agentType: setting.agentType,
      executionId,
      useMultipleOutputs: config.useMultipleOutputs,
    },
  );
  const executionContext = new AgentExecutionContext({
    streamId: streamTabId,
    executionId,
    agentCategory: sessionDescriptor.agentCategory,
  });

  // Configure model handler with agent type and logger
  // This enables provider-specific behavior (e.g., Anthropic context management beta
  // for tool-use agents, OpenAI Response API background mode detection)
  modelHandler.setAgentType(setting.agentType);
  modelHandler.setLogger(executionContext.logger);

  // Determine effective stream ID (may be overridden for resume scenarios)
  const effectiveStreamTabId = options?.streamTabIdOverride ?? streamTabId;

  // Emit setActiveStream BEFORE Init stage creation.
  // This ensures the frontend has state.activeStream set when addTaskGroup arrives,
  // preventing the race condition where Init groups are dropped.
  bus.emit('setActiveStream', {
    stream: effectiveStreamTabId,
    session: sessionDescriptor,
    isRemote: isRemoteAgent(fullConfig.agent),
    hasMultipleOutputs: fullConfig.useMultipleOutputs,
  });

  // 4. Build user variable channels (replaces agent.init() logic)
  // Wrap in "Init" stage so file loading logs are properly grouped
  const initStage = await executionContext.logger.stage('Init');
  let baseVars: Awaited<ReturnType<typeof buildUserVars>>;
  try {
    // Extract just the provider flags needed for prompt variables
    baseVars = await buildUserVars(
      config,
      setting,
      prompt,
      agentPath,
      {
        isOpenai: modelHandler.isOpenai,
        isAnthropic: modelHandler.isAnthropic,
        isGoogle: modelHandler.isGoogle,
      },
      executionContext.logger,
    );
    initStage.end('stopped');
  } catch (err) {
    initStage.end('error');
    throw err;
  }
  const userVarChannels: UserVariableChannels = {
    input: Object.freeze({ ...baseVars }),
    transient: { ...baseVars },
  };

  // 5. Create usage monitor for tracking API usage
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
    executionContext,
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
    executionContext,
    streamTabId,
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
 * @param ctx - Resolved agent base containing stream ID
 * @param streamTabIdOverride - Optional override for stream ID (used in resume scenarios
 *                              where the snapshot's stream ID should be used instead of
 *                              the regenerated one from ctx)
 */
function setupFlowUIState(
  ctx: ResolvedAgentBase,
  streamTabIdOverride?: StreamTabId,
): void {
  const streamTabId = streamTabIdOverride ?? ctx.streamTabId;
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
  context: AgentExecutionContext,
): Promise<void> {
  const errorContext = { operation: `execute ${agentName}` };
  await context.logger.withScope(
    `Error: ${agentName}`,
    async () => context.logger.logError(errorMsg, err, errorContext),
    { errorStatus: 'error' },
  );
}

async function handleFlowError(
  err: unknown,
  agentName: string,
  streamId: StreamTabId,
  context: AgentExecutionContext,
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
  await logFlowError(errorMsg, err, agentName, streamId, context);

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

  const { streamTabId, setting, executionContext, config } = ctx;
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
    await handleFlowError(err, agentName, streamTabId, executionContext);
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

  const { streamTabId, executionContext, config } = ctx;

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
      const fileService = new TaskRunFileService(executionContext.executionId);
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
    await handleFlowError(err, 'merge', streamTabId, executionContext);
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
  const streamTabId = snapshot.streamId as StreamTabId;

  // Resolve agent base with snapshot's stream ID for correct UI state
  // Caller (resumeCommand.ts) handles error display via showWarningMessage
  const ctx = await resolveAgentBase(
    snapshotConfig.agent,
    snapshotConfig,
    executionId,
    { streamTabIdOverride: streamTabId },
  );
  const { setting, executionContext, config } = ctx;

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
    // Use snapshot's stream ID for UI state to maintain consistency
    setupFlowUIState(ctx, streamTabId);

    // Run the flow with resume snapshot
    const result = await runToolUseFlow(
      {
        ...ctx,
        ...interruptManager.asFlowInput(),
        getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
        setting: setting as AgentToolUseSetting,
        streamTabId,
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
      executionContext,
    );
  }
}
