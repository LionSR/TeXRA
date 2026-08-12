import * as path from 'node:path';

import { ZodError } from 'zod';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { isRemoteAgent, resolveAgentForLaunch } from '@agent/index/agentRegistry';
import type { ResolvedAgent } from '@agent/index/agentEntry';
import {
  createChannelTrace,
  logSdkError,
  logUserMessage,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import type { AgentCore } from '@agent/core/flows/BaseFlowServices';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
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
import { ModelCell } from '@agent/runtime/ModelCell';
import { getDisplayedInstruction } from '@agent/runtime/sessionDescription';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { inferPersistedFlowModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { buildUserVars } from '@agent/utils/userVars';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { AgentError } from '@common/errors';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { normalizeRunId } from '@common/constants/runIds';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory, INSTRUCTION_ACTION } from '@shared/schemas';
import type { AgentSource } from '@shared/schemas/agent';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { createRunTrace, type RunTrace } from '@transcript';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  createRunContext,
  withRunContext,
  type CreateLaunchRunContextOptions,
} from './RunContext';
import { createRunScope } from './RunScope';
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  shouldWarnMediaNeedsVision,
} from './mediaVisionWarning';
import { getStreamTabId } from './streamTab';
import { currentSession, type SessionHandle } from './SessionHandle';
import { AgentLaunchResources } from './AgentLaunchResources';
import type { StreamStatusMachine } from './StreamStatusService';
import type { SessionHostInteractions } from './HostInteractions';

const logger = createChannelTrace('AgentLaunchContext');

export interface AgentLaunchContext extends AgentCore {
  usageMonitor: UsageMonitor;
  storageKey: StorageKey;
  parentStage: StageHandle;
  attachedMemoryMisses: AttachedMemoryMiss[];
  /** Abort the sticky signal published on {@link AgentCore.runScope}. */
  interrupt: () => void;
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
  streamTabIdOverride?: StreamTabId;
  /** Fires after streamId is assigned but before setActiveStream is emitted. */
  onBeforeActivation?: (streamId: StreamTabId) => void;
  /** Register the stream without switching the UI away from its current tab. */
  suppressViewSwitch?: boolean;
  /** When true, reject if an explicit category doesn't match the YAML-defined category. */
  enforceCategory?: boolean;
  /** Skip the `requestShowError` toast -- for callers that show their own UI. */
  suppressErrorNotification?: boolean;
  /** Session owning this run's coordination state. Defaults to the launcher's session (`currentSession()`). */
  session?: SessionHandle;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
  /** Deliberate one-run bypass used only by a Copilot direct-key fallback. */
  copilotRouteOverride?: CopilotRouteOverride;
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
    | 'approvalPromptsUnavailable'
    | 'onApprovalPolicyDenial'
    | 'runtimeUnavailableTools'
    | 'stopAfterCycle'
  >,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Single owner of the launch-context → ambient-context mapping, so new
  // per-run flags (e.g. `stopAfterCycle`, `approvalPromptsUnavailable`,
  // `runtimeUnavailableTools`) live in one place and are never silently
  // dropped. Run identity (`streamId`/`executionId`/`agentName`/
  // `workingDirectory`) travels via `ctx.runScope` unchanged, and the model
  // via the run's `ModelCell`, so tools observe a mid-session model switch
  // without depending on the `AgentConfig.model` mirror.
  return await withRunContext(
    createRunContext({
      runScope: ctx.runScope,
      modelCell: ctx.modelCell,
      ...options,
    }),
    fn,
  );
}

export async function getAgentPath(
  agentIdentifier: string,
  interactions: Pick<SessionHostInteractions, 'emit'>,
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

  interactions.emit(
    'showAgentConfigBanner',
    { agentName: agentIdentifier },
    { replayWhenAttached: true },
  );
  throw new AgentError(`Could not find agent: ${agentIdentifier}`);
}

async function validateModelExists(
  modelName: string,
  interactions: Pick<SessionHostInteractions, 'emit'>,
): Promise<ModelConfig> {
  const modelConfig = await resolveRuntimeModelConfig(modelName);
  if (modelConfig) return modelConfig;

  interactions.emit(
    'requestShowInstruction',
    {
      key: 'modelNotRecognized',
      message: `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
      actions: [INSTRUCTION_ACTION.OPEN_MODELS_DOC],
      showSuppress: false,
    },
    { replayWhenAttached: true },
  );
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
 * transcript. See docs/proposals/2026-05-30-progress-grouping-refactor.md (R1).
 */
function beginRunStage(
  agentLogger: AgentTrace,
  label: string,
  instruction: string | undefined,
): StageHandle {
  if (instruction) {
    logUserMessage(agentLogger, instruction);
  }
  return agentLogger.openStage(label, { kind: 'run' });
}

async function assembleAgentLaunchContext(
  input: AgentLaunchInput & { session: SessionHandle },
  executionId: ExecutionId,
  interactions: SessionHostInteractions,
  streamId: StreamTabId,
  resources: AgentLaunchResources,
): Promise<AgentLaunchContext> {
  const fullConfig = input.config;
  // Resolve by the source the delegation captured at validation time, so launch
  // lands on the exact entry validation/display resolved. When no source is
  // pinned (direct launches, restored records), resolution falls to the
  // category-scoped rule validation uses — never blind name resolution.
  const resolution = await getAgentPath(
    fullConfig.agent,
    interactions,
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

  const modelConfig = await validateModelExists(fullConfig.model, interactions);

  const config: AgentConfig = {
    ...fullConfig,
    agentCategory: setting.agentCategory,
  };

  // The session is resolved once at the boundary (buildAgentLaunchContext)
  // and carried in, so a delegated launch inherits the parent run's session
  // policy and a root launch gets the process default exactly once.
  const session = input.session;
  const modelHandlerCompatibilityKey =
    input.modelHandlerCompatibilityKey ??
    (await inferLaunchModelHandlerCompatibilityKey(executionId, config.model));
  const modelHandler = resources.ownModelHandler(
    modelHandlerCompatibilityKey
      ? await createModelHandlerForCompatibilityKey(
          modelConfig,
          modelHandlerCompatibilityKey,
          session.responseTextProcessing,
        )
      : await createModelHandler(
          modelConfig,
          session.responseTextProcessing,
          input.copilotRouteOverride,
        ),
  );
  const modelCell = new ModelCell(modelHandler, config.model);

  const transcriptWriter = await session.transcripts.loadAndAcquireWriter(
    streamId,
    executionId,
  );
  const rawRunTrace = createRunTrace(
    streamId,
    session.transcripts,
    session.flushers,
    executionId,
    transcriptWriter,
  );
  const runTrace = resources.ownRunTrace(rawRunTrace, () => {
    const detachTrace = session.attachRunTrace(rawRunTrace.trace, streamId);
    // Status is a session fact, not an AgentEvent: bridge the hub's canonical
    // status rail into the recorder's transcript-boundary port.
    const detachStatus = session.events.subscribeStatus(
      rawRunTrace.handleStatus,
    );
    return () => {
      detachStatus();
      detachTrace();
    };
  });
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
        ...(input.suppressViewSwitch ? { suppressViewSwitch: true } : {}),
      },
    },
  });
  resources.markActivated(streamId);

  // Log the initial instruction as a user message so both workflow and
  // tool-use tabs display it inline with the stream log (no separate panel).
  const displayInstruction = getDisplayedInstruction(config);
  const initialInstruction =
    displayInstruction && !input.streamTabIdOverride
      ? displayInstruction
      : undefined;
  const supportsMediaInMessage =
    setting.agentCategory === AgentCategory.ToolUse
      ? modelHandler.capabilities.supportsVision ||
        modelHandler.capabilities.supportsNativeAudio
      : modelHandler.capabilities.supportsVision;
  const initialMediaMayBeInserted =
    config.mediaFiles.length > 0 && supportsMediaInMessage;

  const parentStage = resources.ownParentStage(
    beginRunStage(
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
  if (
    shouldWarnMediaNeedsVision(config.mediaFiles, modelHandler.capabilities)
  ) {
    agentLogger.warn(
      formatMediaNeedsVisionWarning(
        countMediaFilesNeedingVision(config.mediaFiles),
        'attached',
        fullConfig.model,
      ),
    );
  }

  const agentPath = path.dirname(resolution.entry.path);
  const workingDirectory = config.workingDirectory?.trim() || undefined;
  const runAbortController = new AbortController();
  const runScope = createRunScope({
    streamId,
    executionId,
    agentName: config.agent,
    workingDirectory,
    delegationAgentScope: fullConfig.delegationAgentScope,
    session,
    signal: runAbortController.signal,
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
    modelCell,
    { logger: agentLogger, storageKey, streamId },
    {
      agentName: config.agent,
      agentCategory: setting.agentCategory,
    },
  );
  return {
    config,
    setting,
    prompt,
    modelCell,
    logger: agentLogger,
    parentStage,
    storageKey,
    userVarChannels,
    attachedMemoryMisses,
    usageMonitor,
    runScope,
    interrupt: () => runAbortController.abort(),
    initialUserMessageForTranscript: initialMediaMayBeInserted
      ? initialInstruction
      : undefined,
    disposeTrace: runTrace.dispose,
  };
}

function acquireStreamOrThrow(
  streamId: StreamTabId,
  streamStatus: StreamStatusMachine,
): void {
  if (streamStatus.tryAcquire(streamId)) {
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
    `Task "${streamId}" is ${statusMsg}. Please wait for it to complete or stop it first.`,
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
        STREAM_TRANSITION_CAUSE.LIFECYCLE,
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
    streamStatus.releaseIfReserved(reservedStreamId);
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
  const { config } = input;
  const launchSession = input.session ?? currentSession();
  const interactions = launchSession.interactions;
  const streamStatus = launchSession.status;
  const executionId = input.executionId ?? generateExecutionId();
  // One mint of this run's stream id: an override is used as-is (resume
  // paths pass the streamId stamped on execution metadata), and otherwise
  // the freshly minted id is both the reservation and the run's identity.
  const streamId =
    input.streamTabIdOverride ?? getStreamTabId(config.agent, { executionId });
  const reservedStreamId = input.streamTabIdOverride ? undefined : streamId;
  if (reservedStreamId) {
    acquireStreamOrThrow(reservedStreamId, streamStatus);
  }

  const resources = new AgentLaunchResources();
  try {
    const ctx = await assembleAgentLaunchContext(
      { ...input, session: launchSession },
      executionId,
      interactions,
      streamId,
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
        err,
        runTrace,
      });
    });
    if (!input.suppressErrorNotification && !(err instanceof ZodError)) {
      interactions.emit(
        'requestShowError',
        { message: toErrorMessage(err) },
        { replayWhenAttached: true },
      );
    }
    throw err;
  }
}
