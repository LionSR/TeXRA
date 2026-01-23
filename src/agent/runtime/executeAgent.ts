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
import { resolveAgent, isRemoteAgent, getAgent } from '@agent/index';
import type { ResolvedAgent } from '@agent/index';
import { createMergeOutputFileLocationGetter } from '@agent/utils/outputFileUtils';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  runToolUseFlow,
  type IToolUseSession,
} from '@agent/implementations/flows/tooluse';
import { runReflectionFlow } from '@agent/implementations/flows/reflection/runReflectionFlow';
import type { AgentCore } from '@agent/implementations/flows/common';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import {
  AgentCategory,
  isWorkflowSetting,
  type AgentSetting,
  type AgentPrompt,
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
import type {
  StreamTabId,
  ExecutionId,
  StorageKey,
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
import { MODEL_CONFIGS } from 'llm-zoo';
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

/**
 * Resolution output after agent loading and initialization.
 *
 * Extends AgentCore with resolution-specific fields:
 * - usageMonitor: For tracking token usage
 * - storageKey: For file organization
 * - parentStage: For logging hierarchy
 */
interface ResolvedAgentBase extends AgentCore {
  usageMonitor: UsageMonitor;
  /** Storage key for file organization (computed once, immutable). */
  storageKey: StorageKey;
  /** Parent stage for flow execution. Round stages are children of this. */
  parentStage: AgentLogStage;
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

// ============================================================================
// Agent Resolution
// ============================================================================

interface ResolveAgentOptions {
  streamTabIdOverride?: StreamTabId;
}

/**
 * Resolve agent and create base dependencies for flow execution.
 * Emits setActiveStream BEFORE stage creation for correct progress board ordering.
 */
async function resolveAgentBase(
  configPayload: AgentConfigPayload,
  providedExecutionId?: ExecutionId,
  options?: ResolveAgentOptions,
): Promise<ResolvedAgentBase> {
  const executionId: ExecutionId =
    providedExecutionId ?? (randomUUID() as ExecutionId);

  // Load and validate agent
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

  // Validate model
  await validateAndGetModelConfig(fullConfig.model);

  // Build final config (only enable multiple outputs if agent supports it)
  const useMultipleOutputs =
    fullConfig.useMultipleOutputs &&
    isWorkflowSetting(setting) &&
    setting.isMultipleOutput;
  const config: AgentConfig = {
    ...fullConfig,
    useMultipleOutputs,
    agentCategory: setting.agentCategory,
  };

  // Create model handler
  const modelHandler = createModelHandler(MODEL_CONFIGS[fullConfig.model]);

  // Compute stream ID
  const streamId =
    options?.streamTabIdOverride ??
    getStreamTabId(config.agent, fullConfig.model, config.inputFile, {
      agentCategory: setting.agentCategory,
      executionId,
      useMultipleOutputs,
    });

  // Create logger and configure model handler
  const agentLogger = new AgentLogger(streamId, true);
  const usageReporter = new AgentUsageReporter(
    agentLogger,
    streamId,
    setting.agentCategory,
  );
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  // Emit stream event before stage creation (prevents race condition)
  bus.emit('setActiveStream', {
    streamId,
    agentCategory: setting.agentCategory,
    isRemote: isRemoteAgent(fullConfig.agent),
    hasMultipleOutputs: useMultipleOutputs,
  });

  // Create parent stage and compute storage key (immutable after this point)
  const parentStage = await agentLogger.stage(`Run: ${config.agent}`);
  const storageKey: StorageKey = parentStage.id
    ? normalizeRunId(parentStage.id)
    : (executionId as StorageKey);

  // Build user variables (workflow agents wrap in Init stage for grouping)
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
      : await (await parentStage.stage('Init')).run(buildVars);

  const userVarChannels: UserVariableChannels = {
    input: Object.freeze({ ...baseVars }),
    transient: { ...baseVars },
  };

  // Create usage monitor
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
      StreamStatusService.set(
        streamId,
        flowStatus === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED,
      );
    }
    logger.debug(`Task completed with status: ${flowStatus}`);
  } catch (err) {
    ctx.parentStage.end(END_GROUP_STATUS.ERROR);
    StreamStatusService.set(streamId, STREAM_STATUS.ERROR);

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
    // (error is already captured in parentStage with ERROR status)
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
    ctx = await resolveAgentBase(configPayload, executionId);
  } catch (err) {
    // Release acquisition on resolution failure
    StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    // Show error to user unless it's a ZodError (handled by executeCommand.ts)
    if (!(err instanceof ZodError)) {
      void vscode.window.showErrorMessage(toErrorMessage(err));
    }
    throw err;
  }

  const { setting, streamId, config } = ctx;
  const agentName = config.agent;

  // Handle stream ID mismatch when useMultipleOutputs was corrected based on agent support.
  // Release the preliminary stream and acquire the correct one.
  if (streamId !== preliminaryStreamId) {
    logger.debug(
      `Stream ID changed: preliminary=${preliminaryStreamId}, resolved=${streamId}. ` +
        'Corrected useMultipleOutputs based on agent support.',
    );
    StreamStatusService.releaseIfInitializing(preliminaryStreamId);
    try {
      acquireStreamOrThrow(streamId);
    } catch (err) {
      // Clean up parentStage if reacquisition fails (resolved stream already in use)
      ctx.parentStage.end(END_GROUP_STATUS.ERROR);
      throw err;
    }
  }

  await runFlowWithLifecycle(ctx, streamId, agentName, async () => {
    if (executionId) await ensureRunDir(executionId);

    const runStorage = getRunStorageService();

    // Set stream status to running
    StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);

    logger.info(`Starting task execution for ${streamId}`);
    logger.info(`Input file: ${config.inputFile}`);
    logger.debug(
      `Stream ID: ${streamId}, Agent: ${agentName}, Model: ${config.model}`,
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
      streamId,
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
          getUsageRecorder: () => (run) =>
            ctx.usageMonitor.recordUsage(run, { runKind: 'tool-use' }),
          setting: ctx.setting as AgentToolUseSetting,
          onFollowUpConsumed: () =>
            bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
        });
        return result.status;
      }

      // Reflection flow execution (direct/CoT/workflow)
      // Pass parentStage so r0, r1 become children of it
      const result = await runReflectionFlow({
        ...ctx,
        ...interruptManager.asFlowInput(),
        getUsageRecorder: () => (run) =>
          ctx.usageMonitor.recordUsage(run, { runKind: 'workflow' }),
        setting: ctx.setting as AgentWorkflowSetting,
        parentStage: ctx.parentStage,
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

      const interruptManager = createInterruptManager();

      // Create merge-specific output file location getter
      const fileService = new TaskRunFileService(executionId);
      const getOutputFileLocation = createMergeOutputFileLocationGetter(
        inputFile,
        editedFile,
        fileService,
      );

      // Run reflection flow with custom file naming
      // Pass parentStage so r0, r1 become children of it
      const result = await runReflectionFlow({
        ...ctx,
        ...interruptManager.asFlowInput(),
        getUsageRecorder: () => (run) =>
          ctx.usageMonitor.recordUsage(run, { runKind: 'workflow' }),
        setting: ctx.setting as AgentWorkflowSetting,
        getOutputFileLocation,
        parentStage: ctx.parentStage,
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
  // Resolve agent base with snapshot's stream ID for correct UI state
  const ctx = await resolveAgentBase(
    snapshot.agentConfig,
    snapshot.executionId,
    {
      streamTabIdOverride: snapshot.streamId,
    },
  );
  const { setting, streamId, config } = ctx;

  // Validate agent category
  if (setting.agentCategory !== AgentCategory.ToolUse) {
    throw new Error(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  }

  const interruptManager = createInterruptManager();

  await runFlowWithLifecycle(
    ctx,
    streamId,
    snapshot.agentConfig.agent,
    async () => {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING);

      // Run the flow with resume snapshot
      const result = await runToolUseFlow(
        {
          ...ctx,
          ...interruptManager.asFlowInput(),
          getUsageRecorder: () => (run) =>
            ctx.usageMonitor.recordUsage(run, { runKind: 'tool-use' }),
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
