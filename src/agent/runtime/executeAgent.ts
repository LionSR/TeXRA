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
import {
  resolveAgent,
  isRemoteAgent,
  getAgent,
  getCleanAgentName,
  getMultipleName,
} from '@agent/index';
import type { ResolvedAgent } from '@agent/index';
import { createMergeOutputFileLocationGetter } from '@agent/utils/outputFileUtils';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  runToolUseFlow,
  type IToolUseSession,
} from '@agent/implementations/flows/tooluse';
import { runReflectionFlow } from '@agent/implementations/flows/reflection/runReflectionFlow';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import {
  AgentCategory,
  type AgentSetting,
  type AgentPrompt,
  type AgentWorkflowSetting,
  type AgentToolUseSetting,
} from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import {
  loadAgentSettingAndPrompts,
  ensureAgentCategoryForSource,
  type AgentLoadOptions,
} from '@agent/runtime/agentLoad';
import { createModelHandler } from '@agent/runtime/ModelFactory';
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
import { getMainWebview } from '@frontend/system/commandUtils';
import type { AgentLogStage } from '@logger/AgentLogger';
import { AgentLogger } from '@logger/AgentLogger';
import { AgentUsageReporter } from '@logger/AgentUsageReporter';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { TaskRunFileService } from '@utils/files';
import { agentConfigToTaskState } from '@utils/config/configConversion';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { bus } from '@eventBus/ProgressEventBus';
import { getStreamTabId } from '@/logger/streamUtils';

import { getRunStorageService } from './RunStorageService';
import { StreamStatusService } from './StreamStatusService';
import { createInterruptManager } from './InterruptManager';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

// ============================================================================
// Types
// ============================================================================

// Re-export for API compatibility
// Canonical source: agentLoad.ts
export type { AgentLoadOptions };

// Re-export for callers that need to build agent configurations
// Canonical source: AgentConfig.ts
export type { AgentConfigPayload };

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
  /** Parent stage for flow execution. Init stage is a child of this. */
  runStage: AgentLogStage;
}

// ============================================================================
// Early Stream ID Computation (Race Condition Prevention)
// ============================================================================

/**
 * Compute a preliminary stream ID from config parameters BEFORE expensive resolution.
 * Used for early duplicate detection to prevent race conditions.
 *
 * This mirrors the logic in getStreamTabId() but uses the agent registry cache
 * to get agentCategory synchronously, avoiding the need for YAML loading.
 */
function computePreliminaryStreamId(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
): StreamTabId {
  const { agent, model, inputFile, useMultipleOutputs } = configPayload;

  if (!agent || !model) {
    throw new Error('Missing required fields: model and/or agent');
  }

  // Get agent category from registry cache (fast synchronous lookup)
  const agentEntry = getAgent(agent);
  const agentCategory = agentEntry?.category ?? AgentCategory.Workflow;

  // Delegate to canonical implementation
  return getStreamTabId(agent, model, inputFile ?? '', {
    agentCategory,
    executionId,
    useMultipleOutputs,
  });
}

// ============================================================================
// Agent Resolution & Preparation
// ============================================================================

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
  configPayload: AgentConfigPayload,
  providedExecutionId?: ExecutionId,
  options?: ResolveAgentOptions,
): Promise<ResolvedAgentBase> {
  // Generate executionId if not provided (always a UUID)
  const executionId: ExecutionId =
    providedExecutionId ?? (randomUUID() as ExecutionId);

  // 1. Resolve agent definition
  // configPayload already contains agent (required by AgentConfigPayload)
  const fullConfig = AgentConfigSchema.parse(configPayload);
  const resolution = await getAgentPath(fullConfig.agent, {
    preferMultiple: fullConfig.useMultipleOutputs,
  });
  const [loadedSettings, prompt] = await loadAgentSettingAndPrompts(
    resolution,
    { preferMultiple: fullConfig.useMultipleOutputs },
  );

  const setting = ensureAgentCategoryForSource(
    loadedSettings,
    resolution.entry.source,
  );
  const agentPath = path.dirname(resolution.definitionPath);

  // 2. Validate and create model handler
  await validateAndGetModelConfig(fullConfig.model);
  const config: AgentConfig = {
    ...fullConfig,
    agentCategory: setting.agentCategory,
  };
  const modelHandler = createModelHandler(MODEL_CONFIGS[fullConfig.model]);

  // 3. Create execution context
  // Compute stream ID, applying override for resume scenarios
  const streamId =
    options?.streamTabIdOverride ??
    getStreamTabId(config.agent, fullConfig.model, config.inputFile, {
      agentCategory: setting.agentCategory,
      executionId,
      useMultipleOutputs: config.useMultipleOutputs,
    });

  // 4. Create logger and usage reporter directly (no AgentExecutionContext wrapper)
  const agentLogger = new AgentLogger(streamId, true);
  const usageReporter = new AgentUsageReporter(
    agentLogger,
    streamId,
    setting.agentCategory,
  );

  // Configure model handler with agent category and logger
  // This enables provider-specific behavior (e.g., Anthropic context management beta
  // for tool-use agents, OpenAI Response API background mode detection)
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  // Emit setActiveStream BEFORE stage creation.
  // This ensures the frontend has state.activeStream set when addTaskGroup arrives,
  // preventing the race condition where groups are dropped.
  bus.emit('setActiveStream', {
    stream: streamId,
    agentCategory: setting.agentCategory,
    isRemote: isRemoteAgent(fullConfig.agent),
    hasMultipleOutputs: fullConfig.useMultipleOutputs,
  });

  // 5. Define mutable storage key with callbacks
  // Initial value is executionId (always UUID, no normalization per runIds.ts:9-10)
  // Updated to runStage.id after stage creation for workflow agents
  const initialStorageKey = executionId as StorageKey;
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

  // 6. Create Run stage FIRST - this is the single top-level session group.
  // Both Init and round stages (r0, r1, etc.) will be children of this stage.
  // This ensures the Sessions dropdown shows only ONE entry per execution.
  const runStage = await agentLogger.stage(`Run: ${config.agent}`);

  // Update storage key to match the run stage ID (for file storage organization)
  if (runStage.id && hasInitialStorageKey()) {
    updateStorageKey(normalizeRunId(runStage.id));
  }

  // 7. Build user variable channels (replaces agent.init() logic)
  // For workflow agents: wrap in Init stage so file loading logs are properly grouped.
  // For tool-use agents: skip Init stage (no file loading to show).
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
      : await (await runStage.stage('Init')).run(buildVars);
  const userVarChannels: UserVariableChannels = {
    input: Object.freeze({ ...baseVars }),
    transient: { ...baseVars },
  };

  // 8. Create usage monitor for tracking API usage
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
    runStage,
  };
}

// ============================================================================
// Flow Execution Helpers
// ============================================================================

const STATUS_MESSAGES: Record<string, string> = {
  [STREAM_STATUS.INITIALIZING]: 'already launching',
  [STREAM_STATUS.RESUMING]: 'resuming',
  [STREAM_STATUS.RUNNING]: 'already running',
};

/**
 * Acquire stream for execution or throw if already in use.
 * Must be called before expensive resolution to prevent race conditions.
 */
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

/** Create a usage recorder callback for flow execution. */
function createUsageRecorder(
  usageMonitor: UsageMonitor,
  runKind: 'workflow' | 'tool-use' = 'workflow',
): () => RoundFinalizedCallback {
  return () => (run) => usageMonitor.recordUsage(run, { runKind });
}

type FlowRunner = () => Promise<EndGroupStatus>;

async function runFlowWithLifecycle(
  ctx: ResolvedAgentBase,
  streamTabId: StreamTabId,
  agentName: string,
  runner: FlowRunner,
): Promise<void> {
  try {
    const flowStatus = await runner();
    ctx.runStage.end(flowStatus);

    if (!StreamStatusService.shouldPreserveOnCompletion(streamTabId)) {
      StreamStatusService.set(
        streamTabId,
        flowStatus === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED,
      );
    }
    logger.debug(`Task completed with status: ${flowStatus}`);
  } catch (err) {
    ctx.runStage.end(END_GROUP_STATUS.ERROR);
    StreamStatusService.set(streamTabId, STREAM_STATUS.ERROR);

    // Handle flow error inline
    const rawMsg = toErrorMessage(err);
    const errorMsg = `Error executing agent ${agentName}: ${getSdkErrorMessage(err)}`;

    // Show appropriate notification based on error type
    const hasApiKeyError =
      rawMsg.includes('Missing API key') ||
      rawMsg.includes('API key not found');
    if (hasApiKeyError) {
      await showApiKeyErrorNotification();
    } else {
      vscode.window.showErrorMessage(errorMsg);
    }

    // Log error directly without creating a new visible group
    // (error is already captured in runStage with ERROR status)
    await ctx.logger.logError(errorMsg, err, {
      operation: `execute ${agentName}`,
    });

    throw new Error(errorMsg);
  }
}

// ============================================================================
// UI and Error Handling
// ============================================================================

/** Show notification when progress view isn't visible. */
function showAgentNotification(config: AgentConfig): void {
  const inputName = config.inputFile
    ? path.basename(config.inputFile)
    : 'selected input';
  const outputFiles = config.outputFiles ?? [];

  let outputInfo = '';
  if (config.useMultipleOutputs && outputFiles.length > 1) {
    outputInfo = `to ${outputFiles.length} files`;
  } else if (outputFiles[0]) {
    outputInfo = `to ${path.basename(outputFiles[0])}`;
  }

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

/** Show API key error notification with action buttons. */
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
// Public API
// ============================================================================

/**
 * Execute an agent with the given configuration.
 *
 * This function runs flows directly without instantiating agent classes.
 * For resuming paused tool-use sessions, use resumeToolUseFromSnapshot instead.
 */
export async function executeAgent(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
): Promise<void> {
  if (!configPayload.model || !configPayload.agent) {
    throw new Error('Missing required fields: model and/or agent');
  }

  // Early acquisition to prevent race conditions.
  // Compute preliminary stream ID and atomically acquire before expensive resolution.
  const preliminaryStreamId = computePreliminaryStreamId(
    configPayload,
    executionId,
  );
  acquireStreamOrThrow(preliminaryStreamId);

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
    // Release acquisition on resolution failure
    StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    // Show error to user unless it's a ZodError (handled by executeCommand.ts)
    if (!(err instanceof ZodError)) {
      void vscode.window.showErrorMessage(toErrorMessage(err));
    }
    throw err;
  }

  const { setting, streamId: streamTabId, config } = ctx;
  const agentName = config.agent;

  // Verify stream IDs match (paranoid check for ID computation consistency)
  if (streamTabId !== preliminaryStreamId) {
    logger.warn(
      `Stream ID mismatch: preliminary=${preliminaryStreamId}, resolved=${streamTabId}. ` +
        'This may indicate a bug in stream ID computation.',
    );
  }

  await runFlowWithLifecycle(ctx, streamTabId, agentName, async () => {
    if (executionId) await ensureRunDir(executionId);

    const runStorage = getRunStorageService();

    // Set stream status to running
    StreamStatusService.set(ctx.streamId, STREAM_STATUS.RUNNING);

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
    const taskStage = await logger.stage(`Task: ${agentName}@${config.model}`);
    return taskStage.run(async () => {
      logger.info(`Executing ${agentName} with model ${config.model}`);

      const interruptManager = createInterruptManager();

      if (setting.agentCategory === AgentCategory.ToolUse) {
        // Tool-use flow execution
        const result = await runToolUseFlow({
          ...ctx,
          ...interruptManager.asFlowInput(),
          getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
          setting: ctx.setting as AgentToolUseSetting,
          onFollowUpConsumed: () =>
            bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
        });
        return result.status;
      }

      // Reflection flow execution (direct/CoT/workflow)
      // Pass runStage as parentStage so r0, r1 become children of it
      const result = await runReflectionFlow({
        ...ctx,
        ...interruptManager.asFlowInput(),
        getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
        setting: ctx.setting as AgentWorkflowSetting,
        parentStage: ctx.runStage,
      });
      return result.status;
    });
  });
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
  // Early acquisition to prevent race conditions
  const preliminaryStreamId = computePreliminaryStreamId({
    agent: 'merge',
    model,
    inputFile,
  });
  acquireStreamOrThrow(preliminaryStreamId, 'Merge task');

  // Flow errors handled by runFlowWithLifecycle; validation errors propagate to VS Code
  // Use finally for cleanup since we just re-throw without transformation
  let ctx: ResolvedAgentBase;
  let resolutionSucceeded = false;
  try {
    ctx = await resolveAgentBase('merge', {
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

  const { streamId: streamTabId, config, executionId } = ctx;

  await runFlowWithLifecycle(ctx, streamTabId, 'merge', async () => {
    StreamStatusService.set(ctx.streamId, STREAM_STATUS.RUNNING);

    const taskStage = await logger.stage(`Task: merge@${model}`);
    return taskStage.run(async () => {
      logger.info(`Executing merge with model ${model}`);

      const interruptManager = createInterruptManager();

      // Create merge-specific output file location getter
      const fileService = new TaskRunFileService(executionId);
      const getOutputFileLocation = createMergeOutputFileLocationGetter(
        inputFile,
        editedFile,
        fileService,
      );

      // Run reflection flow with custom file naming
      // Pass runStage as parentStage so r0, r1 become children of it
      const result = await runReflectionFlow({
        ...ctx,
        ...interruptManager.asFlowInput(),
        getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
        setting: ctx.setting as AgentWorkflowSetting,
        getOutputFileLocation,
        parentStage: ctx.runStage,
      });

      return result.status;
    });
  });
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

  // Resolve agent base with snapshot's stream ID for correct UI state
  // The streamTabIdOverride ensures ctx.streamId matches the snapshot
  // Caller (resumeCommand.ts) handles error display via showWarningMessage
  const ctx = await resolveAgentBase(
    snapshotConfig.agent,
    snapshotConfig,
    snapshot.executionId,
    { streamTabIdOverride: snapshot.streamId },
  );
  const { setting, streamId: streamTabId, config } = ctx;

  // Validate agent category
  if (setting.agentCategory !== AgentCategory.ToolUse) {
    throw new Error(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  }

  const interruptManager = createInterruptManager();

  await runFlowWithLifecycle(
    ctx,
    streamTabId,
    snapshotConfig.agent,
    async () => {
      StreamStatusService.set(ctx.streamId, STREAM_STATUS.RUNNING);

      // Run the flow with resume snapshot
      const result = await runToolUseFlow(
        {
          ...ctx,
          ...interruptManager.asFlowInput(),
          getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
          setting: setting as AgentToolUseSetting,
          resumeSnapshot: snapshot,
          onFollowUpConsumed: () =>
            bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
        },
        setupSession ? (context) => setupSession(context.session) : undefined,
      );

      return result.status;
    },
  );
}
