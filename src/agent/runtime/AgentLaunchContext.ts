import * as path from 'node:path';

import { ZodError } from 'zod';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { createRunTrace, type RunTrace } from '@transcript';
import {
  isRemoteAgent,
  resolveAgentForLaunch,
  type ResolvedAgent,
} from '@agent/index';
import {
  logSdkError,
  logUserMessage,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import { createChannelTrace } from '@agent/trace';
import type { AgentCore } from '@agent/core/flows/BaseFlowServices';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import {
  AttachedMemoryMissesSchema,
  type AttachedMemoryMiss,
} from '@agent/types/AttachedMemory';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import {
  createModelHandler,
  createModelHandlerForCompatibilityKey,
} from '@agent/runtime/ModelFactory';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { inferPersistedFlowModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { buildUserVars } from '@agent/utils/userVars';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { AgentError, getSdkErrorMessage } from '@common/errors';
import { normalizeRunId } from '@common/constants/runIds';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { INSTRUCTION_ACTION } from '@shared/schemas';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import type { AgentSource } from '@shared/schemas/agent';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  createRunContext,
  withRunContext,
  type CreateLaunchRunContextOptions,
} from './RunContext';
import { createRunScope, type RunScope } from './RunScope';
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  shouldWarnMediaNeedsVision,
} from './mediaVisionWarning';
import { getStreamTabId } from './streamTab';
import { currentSession, type SessionHandle } from './SessionHandle';
import { AgentLaunchResources } from './AgentLaunchResources';
import type { StreamStatusMachine } from './StreamStatusService';
import type { AgentRuntimeHost } from './AgentRuntimeHost';

const logger = createChannelTrace('AgentLaunchContext');

export interface AgentLaunchContext extends AgentCore {
  readonly runScope: RunScope;
  usageMonitor: UsageMonitor;
  storageKey: StorageKey;
  parentStage: StageHandle;
  attachedMemoryMisses: AttachedMemoryMiss[];
  /**
   * Dispose the run-trace subscribers (channel sink + transcript recorder)
   * registered by {@link createRunTrace}. Must be called once at end-of-run
   * to avoid leaking entries in the module-global `activeFlushers` set and
   * keeping subscribers attached to the trace emitter.
   */
  disposeTrace: () => void;
}

export interface AgentLaunchInput {
  config: AgentConfig;
  executionId?: ExecutionId;
  runtimeHost: AgentRuntimeHost;
  streamTabIdOverride?: StreamTabId;
  taskType?: string;
  /** Fires after streamId is assigned but before setActiveStream is emitted. */
  onBeforeActivation?: (streamId: StreamTabId) => void;
  /** When true, reject if an explicit category doesn't match the YAML-defined category. */
  enforceCategory?: boolean;
  /** Skip the `requestShowError` toast -- for callers that show their own UI. */
  suppressErrorNotification?: boolean;
  /** Session owning this run's coordination state. Defaults to the launcher's session (`currentSession()`). */
  session?: SessionHandle;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
}

const STATUS_MESSAGES: Record<string, string> = {
  [STREAM_SUBSTATE.STARTING]: 'already launching',
  [STREAM_SUBSTATE.RESUMING]: 'resuming',
  [STREAM_PHASE.RUNNING]: 'already running',
  [STREAM_PHASE.WAITING]: 'waiting for retry',
  [STREAM_PHASE.COMPLETED]: 'completed',
  [STREAM_PHASE.CANCELLED]: 'stopped',
  [STREAM_PHASE.FAILED]: 'failed',
};

export async function withExecutionRunContext<T>(
  ctx: AgentLaunchContext,
  options: Pick<
    CreateLaunchRunContextOptions,
    'approvalPromptsUnavailable' | 'runtimeUnavailableTools' | 'stopAfterCycle'
  >,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Single owner of the launch-context → ambient-context mapping, so new
  // per-run flags (e.g. `stopAfterCycle`, `approvalPromptsUnavailable`,
  // `runtimeUnavailableTools`) live in one place and are never silently
  // dropped. Run identity (`streamId`/`executionId`/`agentName`/
  // `workingDirectory`) travels via `ctx.runScope` unchanged; only
  // `AgentConfig.model` is renamed here, to `RunContext.model`, reading through
  // `getModel` so tools observe model switches applied to
  // `AgentLaunchContext.config.model` during an interactive session.
  return await withRunContext(
    createRunContext({
      runScope: ctx.runScope,
      modelSource: 'live' as const,
      getModel: () => ctx.config.model,
      ...options,
    }),
    fn,
  );
}

export async function getAgentPath(
  agentIdentifier: string,
  runtimeHost: AgentRuntimeHost,
  category: AgentCategory,
  source?: AgentSource | null,
): Promise<ResolvedAgent> {
  // Single launch resolution rule (see resolveAgentForLaunch): exact
  // (source, name) when the delegation pinned one, else the same visible-set
  // resolver validation uses, else the full set for internal agents. Never
  // blind source-priority on a bare name, so launch can't diverge from
  // what was validated.
  const result = resolveAgentForLaunch(category, agentIdentifier, source);
  if (result) return result;

  runtimeHost.emit('showAgentConfigBanner', { agentName: agentIdentifier });
  throw new AgentError(`Could not find agent: ${agentIdentifier}`);
}

async function validateModelExists(
  modelName: string,
  runtimeHost: AgentRuntimeHost,
): Promise<ModelConfig> {
  const modelConfig = await resolveRuntimeModelConfig(modelName);
  if (modelConfig) return modelConfig;

  runtimeHost.emit('requestShowInstruction', {
    key: 'modelNotRecognized',
    message: `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
    actions: [INSTRUCTION_ACTION.OPEN_MODELS_DOC],
    showSuppress: false,
  });
  throw new AgentError(`Model ${modelName} is not registered`);
}

async function inferLaunchModelHandlerCompatibilityKey(
  executionId: ExecutionId,
  model: string,
): Promise<ModelHandlerCompatibilityKey | undefined> {
  try {
    const flowRecord = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );
    return inferPersistedFlowModelHandlerCompatibilityKey(
      model,
      flowRecord?.shared,
    );
  } catch (error) {
    // A failed read here silently falls through to the default model-handler
    // route, which can resume with the wrong provider message format. Warn
    // loudly instead of swallowing it so a bad resume is diagnosable.
    logger.warn(
      'Failed to read flow record for launch, using default model-handler route',
      {
        data: { executionId, error: toErrorMessage(error) },
      },
    );
    return undefined;
  }
}

/**
 * Create a "Run:" stage, optionally logging a user instruction first.
 *
 * ORDERING INVARIANT: The instruction is emitted BEFORE the stage is created.
 * At this point no group context exists, so the message gets no groupId and
 * its timestamp precedes the stage's startTime. The chronological timeline
 * therefore renders the instruction before the run group.
 *
 * ROOT INVARIANT: each run trace owns its stage scope (per-instance
 * AsyncLocalStorage in TraceEmitter), so this opens as a root — it cannot
 * inherit a cross-trace ambient stage from a parent run (e.g. an
 * orchestrator's tool-use stage when this is a subagent). That isolation is
 * what keeps a subagent's "Run:"/Init/r0/r1 subtree from orphaning in its own
 * transcript. See docs/proposals/progress-grouping-refactor.md (R1).
 */
async function beginRunStage(
  agentLogger: AgentTrace,
  label: string,
  instruction: string | undefined,
): Promise<StageHandle> {
  if (instruction) {
    logUserMessage(agentLogger, instruction);
  }
  return agentLogger.openStage(label, { kind: 'run' });
}

async function assembleAgentLaunchContext(
  input: AgentLaunchInput,
  executionId: ExecutionId,
  runtimeHost: AgentRuntimeHost,
  reservedStreamId: StreamTabId | undefined,
  resources: AgentLaunchResources,
): Promise<AgentLaunchContext> {
  const fullConfig = input.config;
  // Resolve by the source the delegation captured at validation time, so launch
  // lands on the exact entry validation/display resolved. When no source is
  // pinned (direct launches, restored records), resolution falls to the
  // category-scoped rule validation uses — never blind name resolution.
  const resolution = await getAgentPath(
    fullConfig.agent,
    runtimeHost,
    fullConfig.agentCategory,
    fullConfig.agentSource,
  );
  // `loadAgentSettingAndPrompts` already applies `ensureAgentCategoryForSource`
  // before parsing, and `AgentSettingSchema` prefaults `agentCategory` (to
  // Workflow when absent), so `setting.agentCategory` is always populated here —
  // a second `ensureAgentCategoryForSource` pass would be a guaranteed no-op.
  const [setting, prompt] = await loadAgentSettingAndPrompts(resolution);

  // Block category mismatch: prevent launching a tool-use agent as a workflow
  // (or vice versa). Source-pinned resolution already guarantees launch lands on
  // the entry validation chose, so this catches only the residual case the
  // registry's pre-merge category can't see: a child agent that `inherits` a
  // parent of the other category resolves with the scanner's pre-merge category
  // (used by getVisibleAgent) but loads a post-merge `setting.agentCategory`
  // that differs. Only enforced when the caller opts in and the category was
  // explicitly supplied before schema defaults were applied.
  if (
    input.enforceCategory &&
    fullConfig.agentCategory !== setting.agentCategory
  ) {
    const suggestion =
      setting.agentCategory === AgentCategory.ToolUse
        ? 'delegate_agent'
        : 'delegate_workflow';
    throw new AgentError(
      `Agent '${fullConfig.agent}' is a ${setting.agentCategory} agent but was launched as ${fullConfig.agentCategory}. Use ${suggestion} instead.`,
    );
  }

  const modelConfig = await validateModelExists(fullConfig.model, runtimeHost);

  const config: AgentConfig = {
    ...fullConfig,
    agentCategory: setting.agentCategory,
  };

  const modelHandlerCompatibilityKey =
    input.modelHandlerCompatibilityKey ??
    (await inferLaunchModelHandlerCompatibilityKey(executionId, config.model));
  const modelHandler = resources.ownModelHandler(
    modelHandlerCompatibilityKey
      ? await createModelHandlerForCompatibilityKey(
          modelConfig,
          modelHandlerCompatibilityKey,
          setting.agentCategory,
        )
      : await createModelHandler(modelConfig, setting.agentCategory),
  );

  const streamId =
    input.streamTabIdOverride ??
    reservedStreamId ??
    getStreamTabId(config.agent, fullConfig.model, { executionId });

  // `currentSession()` (not `defaultSession()`): a delegated launch runs inside
  // the parent run's ALS, so it inherits the parent's session; a root launch
  // runs outside any ALS, so it resolves to the process default. Either way the
  // child is tracked in the same session as its launcher.
  const session = input.session ?? currentSession();
  const rawRunTrace = createRunTrace(
    streamId,
    session.transcripts,
    session.flushers,
  );
  const runTrace = resources.ownRunTrace(rawRunTrace, () =>
    session.attachRunTrace(rawRunTrace.trace, streamId),
  );
  const agentLogger = runTrace.trace;
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  session.events.assertRunSubscribersAttachedBeforeActivation(streamId);
  input.onBeforeActivation?.(streamId);

  session.events.emit({
    scope: 'session',
    event: {
      type: 'setActiveStream',
      payload: {
        streamId,
        agentCategory: setting.agentCategory,
        isRemote: isRemoteAgent(fullConfig.agent),
      },
    },
  });
  resources.markActivated(streamId);

  // Log the initial instruction as a user message so both workflow and
  // tool-use tabs display it inline with the stream log (no separate panel).
  const displayInstruction = (
    config.displayInstruction ?? config.instruction
  )?.trim();
  const initialInstruction =
    displayInstruction && !input.streamTabIdOverride
      ? displayInstruction
      : undefined;
  const initialMediaMayBeInserted =
    config.mediaFiles.length > 0 &&
    (setting.agentCategory === AgentCategory.ToolUse
      ? modelHandler.capabilities.supportsVision ||
        modelHandler.capabilities.supportsNativeAudio
      : modelHandler.capabilities.supportsVision);

  const parentStage = resources.ownParentStage(
    await beginRunStage(
      agentLogger,
      `Run: ${config.agent}`,
      initialMediaMayBeInserted ? undefined : initialInstruction,
    ),
  );
  const storageKey: StorageKey = parentStage.id
    ? normalizeRunId(parentStage.id)
    : (executionId as StorageKey);

  // Tell the user when attached images will be dropped because the chosen model
  // lacks vision. The downstream initializeMessages/addMediaToUserMessage guards
  // drop them silently otherwise.
  const visionMediaCount = countMediaFilesNeedingVision(config.mediaFiles);
  if (
    shouldWarnMediaNeedsVision(config.mediaFiles, modelHandler.capabilities)
  ) {
    agentLogger.warn(
      formatMediaNeedsVisionWarning(
        visionMediaCount,
        'attached',
        fullConfig.model,
      ),
    );
  }

  const agentPath = path.dirname(resolution.definitionPath);
  const workingDirectory = config.workingDirectory?.trim() || undefined;
  const runScope = createRunScope({
    runtimeHost,
    streamId,
    executionId,
    agentName: config.agent,
    workingDirectory,
    delegationAgentScope: fullConfig.delegationAgentScope,
    session,
  });
  const buildVars = () =>
    buildUserVars(
      config,
      setting,
      prompt,
      agentPath,
      {
        isOpenai: modelHandler.config.provider === ModelProvider.OPENAI,
        isAnthropic: modelHandler.config.provider === ModelProvider.ANTHROPIC,
        isGoogle: modelHandler.config.provider === ModelProvider.GOOGLE,
      },
      agentLogger,
      { delegationAgentScope: runScope.delegationAgentScope },
    );

  const baseVars =
    setting.agentCategory === AgentCategory.ToolUse
      ? await buildVars()
      : await parentStage.child('Init').run(buildVars);

  const userVarChannels: UserVariableChannels = {
    input: Object.freeze(baseVars),
    transient: { ...baseVars },
  };
  const attachedMemoryMisses = AttachedMemoryMissesSchema.parse(
    baseVars.ATTACHED_MEMORY_MISSES,
  );

  const usageMonitor = new UsageMonitor(
    { capabilities: modelHandler.capabilities, config: modelHandler.config },
    { logger: agentLogger, runtimeHost, storageKey, streamId },
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
    logger: agentLogger,
    parentStage,
    storageKey,
    userVarChannels,
    attachedMemoryMisses,
    usageMonitor,
    runScope,
    initialUserMessageForTranscript: initialMediaMayBeInserted
      ? initialInstruction
      : undefined,
    disposeTrace: runTrace.dispose,
  };
}

function acquireStreamOrThrow(
  streamId: StreamTabId,
  streamStatus: StreamStatusMachine,
  session: SessionHandle,
  taskType: string = 'Task',
): void {
  if (
    streamStatus.tryAcquire(streamId, {
      events: session.events,
    })
  ) {
    return;
  }

  const substate = streamStatus.getSubstate(streamId);
  const status =
    substate === STREAM_SUBSTATE.STARTING ||
    substate === STREAM_SUBSTATE.RESUMING
      ? substate
      : (streamStatus.get(streamId) ?? '');
  const statusMsg = STATUS_MESSAGES[status] || 'already running';
  throw new AgentError(
    `${taskType} "${streamId}" is ${statusMsg}. Please wait for it to complete or stop it first.`,
  );
}

/**
 * Saga-style compensation for a failed stream activation.
 *
 *  - Pre-activation failure (no `activatedStreamId`): the UI tab was never
 *    registered. Release the reserved lock if we held it, and publish a
 *    terminal rollback only if acquisition already emitted a visible status.
 *
 *  - Post-activation failure (`activatedStreamId` set): the UI tab is
 *    visible. Surface the failure on it and transition to FAILED so the
 *    tab doesn't hang in STARTING.
 */
function compensateFailedActivation(args: {
  config: AgentConfig;
  reservedStreamId?: StreamTabId;
  activatedStreamId?: StreamTabId;
  streamStatus: StreamStatusMachine;
  session: SessionHandle;
  err: unknown;
  // The run-trace from assembleAgentLaunchContext when it was created before the
  // throw. Reused for the error log so we don't allocate a second one; outer
  // catch disposes it after this returns.
  runTrace?: RunTrace;
}): void {
  const {
    config,
    reservedStreamId,
    activatedStreamId,
    streamStatus,
    session,
    err,
    runTrace,
  } = args;

  if (activatedStreamId) {
    // `activatedStreamId` is set only after `runTrace` is created in
    // `assembleAgentLaunchContext`, so runTrace is always present here in
    // practice. Guard for defensiveness.
    if (runTrace) {
      logSdkError(
        runTrace.trace,
        `Failed to start agent ${config.agent}: ${getSdkErrorMessage(err)}`,
        err,
        { operation: `start ${config.agent}` },
      );
    }
    if (
      !streamStatus.transitionToTerminal(
        activatedStreamId,
        STREAM_PHASE.FAILED,
        {
          trace: runTrace?.trace,
          ...(runTrace ? {} : { events: session.events }),
        },
      )
    ) {
      runTrace?.trace.warn('Failed to mark activation failure terminal', {
        data: {
          agentIdentifier: config.agent,
          streamId: activatedStreamId,
        },
      });
    }
    return;
  }

  if (reservedStreamId) {
    streamStatus.releaseIfReserved(reservedStreamId, {
      events: session.events,
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
  const { config, runtimeHost } = input;
  const launchSession = input.session ?? currentSession();
  const streamStatus = launchSession.status;
  const executionId = input.executionId ?? generateExecutionId();
  if (!input.streamTabIdOverride && (!config.agent || !config.model)) {
    throw new AgentError('Missing required fields: model and/or agent');
  }
  const reservedStreamId = input.streamTabIdOverride
    ? undefined
    : getStreamTabId(config.agent, config.model, { executionId });
  if (reservedStreamId) {
    acquireStreamOrThrow(
      reservedStreamId,
      streamStatus,
      launchSession,
      input.taskType,
    );
  }

  const resources = new AgentLaunchResources();
  try {
    const ctx = await assembleAgentLaunchContext(
      { ...input, session: launchSession },
      executionId,
      runtimeHost,
      reservedStreamId,
      resources,
    );
    resources.transfer();
    return ctx;
  } catch (err) {
    resources.fail((activatedStreamId, runTrace) => {
      compensateFailedActivation({
        config,
        reservedStreamId,
        activatedStreamId,
        streamStatus,
        session: launchSession,
        err,
        runTrace,
      });
    });
    if (!input.suppressErrorNotification && !(err instanceof ZodError)) {
      runtimeHost.emit('requestShowError', {
        message: toErrorMessage(err),
      });
    }
    throw err;
  }
}
