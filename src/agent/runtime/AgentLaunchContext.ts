import * as path from 'path';

import { ZodError } from 'zod';
import { MODEL_CONFIGS } from 'llm-zoo';

import { isRemoteAgent, resolveAgent, type ResolvedAgent } from '@agent/index';
import type { AgentCore } from '@agent/implementations/flows/common/BaseFlowServices';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import {
  ensureAgentCategoryForSource,
  loadAgentSettingAndPrompts,
} from '@agent/runtime/agentLoad';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { buildUserVars } from '@agent/utils/userVars';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { AgentError, getSdkErrorMessage, toErrorMessage } from '@common/errors';
import { normalizeRunId } from '@common/constants/runIds';
import {
  AgentLogger,
  AgentUsageReporter,
  getStreamTabId,
  type AgentLogStage,
} from '@logger/index';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

import { AgentProposalCoordinator } from './AgentProposalCoordinator';
import { getAgentRuntimeHost, type AgentRuntimeHost } from './AgentRuntimeHost';
import { PlanApprovalCoordinator } from './PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from './RetryRequestCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from './RunContext';
import { retainRunCoordinatorsForStream } from './runCoordinators';
import { StreamStatusService } from './StreamStatusService';

export interface AgentLaunchContext extends AgentCore {
  usageMonitor: UsageMonitor;
  storageKey: StorageKey;
  parentStage: AgentLogStage;
  coordinators: RunCoordinators;
}

export interface AgentLaunchInput {
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

const STATUS_MESSAGES: Record<string, string> = {
  [STREAM_STATUS.INITIALIZING]: 'already launching',
  [STREAM_STATUS.RESUMING]: 'resuming',
  [STREAM_STATUS.RUNNING]: 'already running',
  [STREAM_STATUS.WAITING]: 'waiting for retry',
};

export async function withExecutionRunContext<T>(
  ctx: AgentLaunchContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  const release = retainRunCoordinatorsForStream(
    ctx.streamId,
    ctx.coordinators,
  );
  try {
    const runContext = createRunContext({
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
    return await withRunContext(runContext, fn);
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
 * its timestamp precedes the stage's startTime. The chronological timeline
 * therefore renders the instruction before the run group.
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
export async function buildAgentLaunchContext(
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
