/**
 * Agent execution module - Flow-First Architecture.
 *
 * This module provides direct flow execution without agent class instantiation.
 * Flows run directly, bypassing the agent class hierarchy entirely.
 *
 * Entry points:
 * - executeAgent: Execute a new agent run (or resume with { resume: true })
 * - executeMergeAgent: Execute the merge agent (flow-first with custom file naming)
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

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
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { normalizeRunId } from '@common/constants/runIds';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
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

export interface ExecuteAgentOptions {
  resume?: boolean;
}

/**
 * Prepared execution context for flow-first execution.
 */
interface FlowExecutionContext {
  modelHandler: IModelHandler<any, any, any, any, any>;
  agentConfig: AgentConfig;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  agentPath: string;
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
 * Prepare execution context for flow-first execution.
 * Creates all dependencies needed to run flows directly without agent classes.
 */
async function prepareFlowExecution(
  agentName: string,
  configPayload: Partial<AgentConfig>,
  executionId?: ExecutionId,
): Promise<FlowExecutionContext> {
  // 1. Resolve agent definition
  const fullConfig = AgentConfigSchema.parse({
    agent: agentName,
    ...configPayload,
  });
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
  const agentPath = path.dirname(resolution.definitionPath);

  // 2. Validate and create model handler
  await validateAndGetModelConfig(fullConfig.model);
  const agentConfig: AgentConfig = {
    ...fullConfig,
    agentType: sessionDescriptor.agentType,
    session: sessionDescriptor,
  };
  const modelConfig = {
    ...MODEL_CONFIGS[fullConfig.model],
    toolConfig: agentConfig.toolConfig,
  };
  const modelHandler = ModelFactory.createHandler(modelConfig);

  // 3. Create execution context
  const streamTabId = getStreamTabId(
    agentConfig.agent,
    fullConfig.model,
    agentConfig.inputFile,
    {
      agentType: agentSetting.agentType,
      executionId,
      useMultipleOutputs: agentConfig.useMultipleOutputs,
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
  modelHandler.setAgentType(agentSetting.agentType);
  modelHandler.setLogger(executionContext.logger);

  // 4. Build user variable channels (replaces agent.init() logic)
  // Wrap in "Init" stage so file loading logs are properly grouped
  const initStage = await executionContext.logger.stage('Init');
  let baseVars: Awaited<ReturnType<typeof buildUserVars>>;
  try {
    baseVars = await buildUserVars(
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
      modelHandler,
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
  const isMultipleOutput =
    agentSetting.agentCategory === AgentCategory.Workflow
      ? (agentSetting as AgentWorkflowSetting).isMultipleOutput
      : undefined;

  const usageMonitor = new UsageMonitor(modelHandler, executionContext, {
    agentName: agentConfig.agent,
    agentCategory: agentSetting.agentCategory,
    isMultipleOutput,
  });

  return {
    modelHandler,
    agentConfig,
    agentSetting,
    agentPrompt,
    agentPath,
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
 * Execute an agent with the provided configuration.
 *
 * ## Flow-First Architecture
 *
 * This function runs flows directly without instantiating agent classes.
 * The flow contexts create all necessary services internally.
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

  // Prepare flow execution context
  const ctx = await prepareFlowExecution(
    agentConfig.agent,
    agentConfig,
    executionId,
  );

  const { streamTabId, agentSetting, executionContext } = ctx;
  const config = ctx.agentConfig;
  const agentName = config.agent;

  if (!config.session) {
    throw new Error('Agent configuration is missing session metadata.');
  }

  // Check if already running before any state modifications
  const currentStatus = StreamStatusService.get(streamTabId);
  if (!isResume && currentStatus === STREAM_STATUS.RUNNING) {
    throw new Error(
      `Task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`,
    );
  }
  if (isResume && currentStatus === STREAM_STATUS.RESUMING) {
    throw new Error(`Task "${streamTabId}" is already being resumed.`);
  }

  // Handle resume state
  // Note: Full resume hydration is handled internally by agents/flows
  // Here we just set the status for UI feedback
  if (isResume && agentSetting.agentType !== 'toolUse' && executionId) {
    StreamStatusService.set(streamTabId, STREAM_STATUS.RESUMING);
  }

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
    }

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
    await logger.withScope(
      `Task: ${agentName}@${config.model}`,
      async () => {
        logger.info(`Executing ${agentName} with model ${config.model}`);

        // Create interrupt manager (replaces mutable interruptState object)
        const interruptManager = new InterruptManager();

        let flowStatus: 'error' | 'stopped';

        if (agentSetting.agentType === 'toolUse') {
          // Tool-use flow execution
          const result = await runToolUseFlow(
            {
              modelHandler: ctx.modelHandler,
              config: ctx.agentConfig,
              setting: ctx.agentSetting as AgentToolUseSetting,
              prompt: ctx.agentPrompt,
              executionContext: ctx.executionContext,
              userVarChannels: ctx.userVarChannels,
              streamTabId: ctx.streamTabId,
              checkInterruption: interruptManager.checkInterruption,
              setAbortController: interruptManager.setAbortController,
              // Get fresh client each response round to ensure auth keys are refreshed
              getClient: () => ctx.modelHandler.getClient(),
              getUsageRecorder: createUsageRecorder(
                ctx.usageMonitor,
                'tool-use',
              ),
              onInterrupt: interruptManager.onInterrupt,
            },
            {
              onContextReady: (streamId, context) => {
                registerInterruptible(streamId, context);
              },
              onFlowComplete: (streamId) => {
                unregisterInterruptible(streamId);
              },
            },
          );
          flowStatus = result.status;
        } else {
          // Reflection flow execution (direct/CoT/workflow)
          const result = await runReflectionFlow(
            {
              modelHandler: ctx.modelHandler,
              config: ctx.agentConfig,
              setting: ctx.agentSetting as AgentWorkflowSetting,
              prompt: ctx.agentPrompt,
              executionContext: ctx.executionContext,
              userVarChannels: ctx.userVarChannels,
              checkInterruption: interruptManager.checkInterruption,
              setAbortController: interruptManager.setAbortController,
              // Get fresh client each response round to ensure auth keys are refreshed
              getClient: () => ctx.modelHandler.getClient(),
              getUsageRecorder: createUsageRecorder(
                ctx.usageMonitor,
                'workflow',
              ),
              onInterrupt: interruptManager.onInterrupt,
            },
            {
              onContextReady: (_storageKey, context) => {
                registerInterruptible(streamTabId, context);
              },
              onFlowComplete: () => {
                unregisterInterruptible(streamTabId);
              },
            },
          );
          flowStatus = result.status;
        }

        // Update stream status based on flow result
        // Tool-use flows can pause in WAITING state - don't override that
        const currentStatus = StreamStatusService.get(streamTabId);
        if (currentStatus !== STREAM_STATUS.WAITING) {
          StreamStatusService.set(
            streamTabId,
            flowStatus === 'error'
              ? STREAM_STATUS.ERROR
              : STREAM_STATUS.STOPPED,
          );
        }
        logger.debug(`Task completed with status: ${flowStatus}`);
      },
      { skip: isResume },
    );
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
  const ctx = await prepareFlowExecution('merge', {
    agent: 'merge',
    model,
    inputFile,
    editedFile,
  });

  const { streamTabId, executionContext } = ctx;

  // Check if already running
  const currentStatus = StreamStatusService.get(streamTabId);
  if (currentStatus === STREAM_STATUS.RUNNING) {
    throw new Error(
      `Merge task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`,
    );
  }

  try {
    // Setup UI state
    bus.emit('setActiveStream', {
      stream: streamTabId,
      session: ctx.agentConfig.session!,
      isRemote: isRemoteAgent(ctx.agentConfig.agent),
      hasMultipleOutputs: ctx.agentConfig.useMultipleOutputs,
    });
    StreamStatusService.set(streamTabId, STREAM_STATUS.RUNNING);

    await logger.withScope(`Task: merge@${model}`, async () => {
      logger.info(`Executing merge with model ${model}`);

      // Create interrupt manager
      const interruptManager = new InterruptManager();

      // Create file service for merge-specific output location
      const fileService = new TaskRunFileService(executionContext.executionId);

      // Create merge-specific output file location getter
      const getOutputFileLocation = createMergeOutputFileLocationGetter(
        inputFile,
        editedFile,
        fileService,
      );

      // Run reflection flow with custom file naming
      const result = await runReflectionFlow(
        {
          modelHandler: ctx.modelHandler,
          config: ctx.agentConfig,
          setting: ctx.agentSetting as AgentWorkflowSetting,
          prompt: ctx.agentPrompt,
          executionContext: ctx.executionContext,
          userVarChannels: ctx.userVarChannels,
          checkInterruption: interruptManager.checkInterruption,
          setAbortController: interruptManager.setAbortController,
          // Get fresh client each response round to ensure auth keys are refreshed
          getClient: () => ctx.modelHandler.getClient(),
          getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
          getOutputFileLocation,
          onInterrupt: interruptManager.onInterrupt,
        },
        {
          onContextReady: (_storageKey, context) => {
            registerInterruptible(streamTabId, context);
          },
          onFlowComplete: () => {
            unregisterInterruptible(streamTabId);
          },
        },
      );

      logger.debug(`Task completed successfully`);
      StreamStatusService.set(
        streamTabId,
        result.status === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED,
      );
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
  const config = snapshot.agentConfig;
  const executionId = snapshot.executionId as ExecutionId;
  const streamTabId = snapshot.streamId as StreamTabId;

  // Prepare flow execution context
  const ctx = await prepareFlowExecution(config.agent, config, executionId);
  const {
    modelHandler,
    agentConfig,
    agentSetting,
    agentPrompt,
    executionContext,
    userVarChannels,
    usageMonitor,
  } = ctx;

  // Validate agent type
  if (agentSetting.agentType !== 'toolUse') {
    throw new Error(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  }

  // Create interrupt manager
  const interruptManager = new InterruptManager();

  try {
    // Setup UI state for resume
    bus.emit('setActiveStream', {
      stream: streamTabId,
      session: agentConfig.session!,
      isRemote: isRemoteAgent(agentConfig.agent),
      hasMultipleOutputs: agentConfig.useMultipleOutputs,
    });
    StreamStatusService.set(streamTabId, STREAM_STATUS.RUNNING);

    // Run the flow with resume snapshot
    const result = await runToolUseFlow(
      {
        modelHandler,
        config: agentConfig,
        setting: agentSetting as AgentToolUseSetting,
        prompt: agentPrompt,
        executionContext,
        userVarChannels,
        streamTabId,
        checkInterruption: interruptManager.checkInterruption,
        setAbortController: interruptManager.setAbortController,
        // Get fresh client each response round to ensure auth keys are refreshed
        getClient: () => modelHandler.getClient(),
        getUsageRecorder: createUsageRecorder(usageMonitor, 'tool-use'),
        resumeSnapshot: snapshot,
        onInterrupt: interruptManager.onInterrupt,
      },
      {
        onContextReady: (streamId, context) => {
          registerInterruptible(streamId, context);

          // Allow caller to configure session (e.g., append follow-ups)
          if (setupSession) {
            setupSession(context.session);
          }
        },
        onFlowComplete: (streamId) => {
          unregisterInterruptible(streamId);
        },
      },
    );

    // Only set status if flow actually completed (not paused waiting for follow-up)
    const finalStatus = StreamStatusService.get(streamTabId);
    if (finalStatus !== STREAM_STATUS.WAITING) {
      StreamStatusService.set(
        streamTabId,
        result.status === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED,
      );
    }
  } catch (error) {
    StreamStatusService.set(streamTabId, STREAM_STATUS.ERROR);
    await handleFlowError(error, config.agent, streamTabId, executionContext);
    throw error;
  }
}
