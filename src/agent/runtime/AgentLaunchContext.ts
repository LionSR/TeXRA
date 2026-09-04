import * as path from 'node:path';

import { ZodError } from 'zod';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { isRemoteAgent, resolveAgentForLaunch } from '@agent/index';
import {
  logSdkError,
  logUserMessage,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import type { ResolvedAgent } from '@agent/index/agentEntry';
import {
  createToolPolicy,
  type AgentCore,
  type ToolPolicy,
} from '@agent/core/flows/BaseFlowServices';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';
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
import { buildUserVars } from '@agent/prompt/userVars';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { AgentError, classifyAgentError } from '@common/errors';
import {
  attachErrorPresentationClaimed,
  hasErrorPresentationClaimed,
} from '@common/errors/sdkError/errorMetadata';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { DisposableStore } from '@platform/disposable';
import type {
  AgentSource,
  ExecutionId,
  StreamTabId,
  UserFollowUpSupport,
} from '@shared/schemas';
import {
  AgentCategory,
  INSTRUCTION_ACTION,
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { createRunTrace, type RunTrace } from '@transcript';
import { linkAbortSignals } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { launchWorktreeInfo } from '@utils/git/worktreeInfo';

import { createRunContext, withRunContext } from './RunContext';
import { createRunScope } from './RunScope';
import { mediaNeedsVisionWarning } from './mediaVisionWarning';
import { getStreamTabId } from './streamTab';
import { currentSession, type SessionHandle } from './SessionHandle';
import type { StreamStatusMachine } from './StreamStatusService';
import type { SessionHostInteractions } from './HostInteractions';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

const logger = createLog('AgentLaunchContext');

export interface AgentLaunchContext extends AgentCore {
  /** Description from the exact registry entry selected for this launch. */
  resolvedAgentDescription?: string;
  usageMonitor: UsageMonitor;
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

interface AgentLaunchInput {
  config: AgentConfig;
  executionId: ExecutionId;
  streamTabIdOverride?: StreamTabId;
  /**
   * Fires once the stream's `run.start` is published, before the run itself
   * begins: the stream exists for every fold by then, so a host may select
   * it (its own surface state, never a fact) and approval ancestry may be
   * registered against it.
   */
  onStreamResolved?: (streamId: StreamTabId) => void;
  /** Delegated child of another run; carried on the failure `result`. */
  isSubagent?: boolean;
  /** Stream this run was launched from, stamped on `run.start`. */
  parentStreamId?: StreamTabId;
  /** A workflow-script run's resume anchor, stamped on `run.start`
   *  (decision 9): the checkpoint it journals into. */
  checkpointId?: string;
  /** Runtime behavior declared by the launch source, stamped on `run.start`. */
  userFollowUpSupport?: UserFollowUpSupport;
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
  /** Cancel launch preparation and the resulting live run. */
  signal?: AbortSignal;
  /** Immutable per-run tool policy carried on the launch context for cycle flows. */
  toolPolicy?: ToolPolicy;
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
  options: { onApprovalPolicyDenial?: () => void } = {},
  fn: () => T | Promise<T>,
): Promise<T> {
  // Single owner of the launch-context → ambient-context mapping. The
  // tool-policy fields (`approvalPromptsUnavailable`, `runtimeUnavailableTools`,
  // `stopAfterCycle`) are projected straight from `ctx.toolPolicy` so callers
  // can't drift a hand-maintained copy of the same values; only
  // `onApprovalPolicyDenial` (a callback that is not part of ToolPolicy) is
  // still supplied explicitly. Run identity (`streamId`/`executionId`/
  // `agentName`/`workingDirectory`) travels via `ctx.runScope` unchanged, and
  // the model via the run's `ModelCell`, so tools observe a mid-session model
  // switch without depending on the `AgentConfig.model` mirror.
  return await withRunContext(
    createRunContext({
      runScope: ctx.runScope,
      modelCell: ctx.modelCell,
      approvalPromptsUnavailable: ctx.toolPolicy.approvalPromptsUnavailable,
      runtimeUnavailableTools: ctx.toolPolicy.runtimeUnavailableTools,
      stopAfterCycle: ctx.toolPolicy.stopAfterCycle,
      onApprovalPolicyDenial: options.onApprovalPolicyDenial,
    }),
    fn,
  );
}

/**
 * Present an error through the host and throw it, tracking whether the host
 * actually rendered it so the caller can avoid a duplicate fallback toast.
 */
async function presentLaunchError<K extends RuntimePresentationEvent>(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  err: AgentError,
  event: K,
  payload: RuntimePresentationEventPayloads[K],
): Promise<never> {
  const delivered = await interactions.emit(event, payload, {
    replayWhenAttached: true,
    onReplayScheduled: () => attachErrorPresentationClaimed(err),
    onReplayNotDelivered: (host) => {
      host.emit?.('requestShowError', { message: toErrorMessage(err) });
    },
  });
  // Claim presentation only when a live host confirmed it rendered the
  // targeted notice, or when the notice was retained for replay (the replay
  // owns the eventual fallback). A live-host emit that throws synchronously
  // is normalized to `false` by `SessionHostInteractions.emit`, leaving the
  // marker unset so the launch catch emits the generic fallback.
  if (delivered) attachErrorPresentationClaimed(err);
  throw err;
}

async function getAgentPath(
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

  throw await presentLaunchError(
    interactions,
    new AgentError(`Could not find agent: ${agentIdentifier}`),
    'showAgentConfigBanner',
    { agentName: agentIdentifier },
  );
}

async function validateModelExists(
  modelName: string,
  interactions: Pick<SessionHostInteractions, 'emit'>,
): Promise<ModelConfig> {
  const modelConfig = await resolveRuntimeModelConfig(modelName);
  if (modelConfig) return modelConfig;

  throw await presentLaunchError(
    interactions,
    new AgentError(`Model ${modelName} is not registered`),
    'requestShowInstruction',
    {
      key: 'modelNotRecognized',
      message: `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
      actions: [INSTRUCTION_ACTION.OPEN_MODELS_DOC],
      showSuppress: false,
    },
  );
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
  streamId: StreamTabId,
  resources: DisposableStore,
  onStarted: (runTrace: RunTrace, category: AgentCategory) => void,
): Promise<AgentLaunchContext> {
  input.signal?.throwIfAborted();
  const fullConfig = input.config;
  const interactions = input.session.interactions;
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
  input.signal?.throwIfAborted();
  // `loadAgentSettingAndPrompts` already fills the built-in tool-use category
  // default before parsing, and `AgentSettingSchema` prefaults `agentCategory`
  // (to Workflow when absent), so `setting.agentCategory` is always populated
  // here — a second defaulting pass would be a guaranteed no-op.
  const [setting, prompt] = await loadAgentSettingAndPrompts(resolution);
  input.signal?.throwIfAborted();

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
  input.signal?.throwIfAborted();

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
  input.signal?.throwIfAborted();
  const modelHandler = resources.add(
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
  input.signal?.throwIfAborted();
  const modelCell = new ModelCell(modelHandler, config.model);

  const transcriptWriter = await session.transcripts.loadAndAcquireWriter(
    streamId,
    executionId,
  );
  input.signal?.throwIfAborted();
  const rawRunTrace = createRunTrace(
    streamId,
    session.transcripts,
    session.flushers,
    executionId,
    transcriptWriter,
  );
  // The composed trace enters the store BEFORE session attachment, so a
  // failed attachment still disposes the raw trace through the store.
  const attachment: { detach?: () => void } = {};
  const runTrace = resources.add<RunTrace>({
    trace: rawRunTrace.trace,
    handleStatus: rawRunTrace.handleStatus,
    flushSpills: rawRunTrace.flushSpills,
    dispose: () => {
      try {
        attachment.detach?.();
      } finally {
        rawRunTrace.dispose();
      }
    },
  });
  {
    let traceDisposed = false;
    const removeSpillFlusher = session.useArtifactFlusher(async () => {
      await rawRunTrace.flushSpills();
      if (traceDisposed) removeSpillFlusher();
    });
    let detachTrace: (() => void) | undefined;
    try {
      // The trace's durable arms and the recorder's status port, one
      // attachment: status is a session fact, not an AgentEvent, and the
      // recorder hears it through the session in transcript order.
      detachTrace = session.attachRunTrace(rawRunTrace, streamId);
      attachment.detach = () => {
        // Keep the flusher through the execution lease's post-dispose drain.
        // Its next successful flush removes it from the session.
        traceDisposed = true;
        detachTrace?.();
      };
    } catch (error) {
      detachTrace?.();
      removeSpillFlusher();
      throw error;
    }
  }
  const agentLogger = runTrace.trace;
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  input.signal?.throwIfAborted();
  const isRemote = isRemoteAgent(fullConfig.agent);
  // The reservation commit point: the existence fact. From here the stream
  // is real for every fold, and a failure below ends it with a terminal
  // `result` instead of releasing the reservation (PRD
  // one-fold-three-renderers, section 6, item 3). The launch facts the fold
  // reads verbatim (item 6) are all known here; the run's own `run.config`
  // follows once the lifecycle starts. A resume (`streamTabIdOverride`)
  // activates an existing stream and mints no `run.start` (decision 9).
  if (!input.streamTabIdOverride) {
    agentLogger.emit({
      type: 'run.start',
      streamId,
      executionId,
      identity: { kind: 'agent', agent: config.agent },
      userFollowUpSupport:
        input.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: setting.agentCategory,
      isRemote,
      worktree: launchWorktreeInfo(config.workingDirectory),
      ...(input.parentStreamId && input.parentStreamId !== streamId
        ? { parentStreamId: input.parentStreamId }
        : {}),
      // A delegated child runs in the background whoever is watching.
      background: input.isSubagent ?? false,
      // The initial policy snapshot (PRD 6, item 2). A delegated child's
      // ancestry is registered from `onStreamResolved` below, after this
      // event; the queue publishes a fresh `approval.policy` for every value
      // the edge changes, so the fold's latest-of-type entry ends correct.
      approvalPolicy: session.approvalPolicySnapshotFor(streamId),
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
    });
  }
  // Every activation, first launch and resume alike (PRD 6, item 8).
  agentLogger.emit({
    type: 'run.activate',
    streamId,
    category: setting.agentCategory,
    isRemote,
    background: input.isSubagent ?? false,
  });
  onStarted(runTrace, setting.agentCategory);
  input.onStreamResolved?.(streamId);

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

  const parentStage = beginRunStage(
    agentLogger,
    `Run: ${config.agent}`,
    initialMediaMayBeInserted ? undefined : initialInstruction,
  );
  resources.add(() => parentStage.end(RUN_OUTCOME.FAILED));

  // Tell the user when attached images will be dropped because the chosen model
  // lacks vision. The downstream initializeMessages/addMediaToUserMessage guards
  // drop them silently otherwise.
  const visionWarning = mediaNeedsVisionWarning(
    config.mediaFiles,
    modelHandler.capabilities,
    'attached',
    fullConfig.model,
  );
  if (visionWarning) agentLogger.warn(visionWarning);

  const agentPath = path.dirname(resolution.entry.path);
  const workingDirectory = config.workingDirectory?.trim() || undefined;
  const runAbortController = new AbortController();
  // Linked, not composed: `AbortSignal.any` would keep this run's signal (and
  // every listener still attached to it) reachable from the caller's signal
  // until that signal aborts. A parent run's signal outlives each subagent it
  // launches, so a long orchestration would retain every finished child's run
  // scope. The link is detached with the run trace at end-of-run.
  const detachRunAbortLink = resources.add(
    linkAbortSignals([input.signal], runAbortController),
  );
  const runSignal = runAbortController.signal;
  const runScope = createRunScope({
    streamId,
    executionId,
    agentName: config.agent,
    workingDirectory,
    delegationAgentScope: fullConfig.delegationAgentScope,
    session,
    signal: runSignal,
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
  input.signal?.throwIfAborted();

  const userVarChannels: UserVariableChannels = { ...baseVars };
  const attachedMemoryMisses = baseVars.ATTACHED_MEMORY_MISSES;

  const usageMonitor = new UsageMonitor(
    modelCell,
    {
      logger: agentLogger,
      executionId,
      runStageId: parentStage.id,
      streamId,
    },
    {
      agentName: config.agent,
      agentCategory: setting.agentCategory,
    },
  );
  return {
    config,
    resolvedAgentDescription: resolution.entry.description,
    setting,
    prompt,
    modelCell,
    toolPolicy: createToolPolicy(input.toolPolicy),
    logger: agentLogger,
    parentStage,
    userVarChannels,
    attachedMemoryMisses,
    usageMonitor,
    runScope,
    interrupt: () => runAbortController.abort(),
    initialUserMessageForTranscript: initialMediaMayBeInserted
      ? initialInstruction
      : undefined,
    disposeTrace: () => {
      detachRunAbortLink();
      runTrace.dispose();
    },
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
 * Saga-style compensation for a launch that failed after its `run.start`
 * was published: the stream exists for every fold, so end it there with its
 * terminal `result` and transition to FAILED rather than leaving a stream
 * that started and never ran. The `result` is the run's end for the fold and
 * for `session.onResult` (the hosts' terminal toast), so it claims the
 * error's presentation the way every other run failure does.
 *
 * A failure before `run.start` has no stream and only releases the reserved
 * lock; that one line is inlined at its call site.
 */
function compensateStartedFailure(args: {
  config: AgentConfig;
  category: AgentCategory;
  executionId: ExecutionId;
  streamId: StreamTabId;
  isSubagent: boolean;
  runTrace: RunTrace;
  streamStatus: StreamStatusMachine;
  err: unknown;
}): void {
  const {
    config,
    category,
    executionId,
    streamId,
    isSubagent,
    runTrace,
    streamStatus,
    err,
  } = args;
  const message = `Failed to start agent ${config.agent}: ${getSdkErrorMessage(err)}`;
  logSdkError(runTrace.trace, message, err, {
    operation: `start ${config.agent}`,
  });
  runTrace.trace.emit({
    type: 'result',
    outcome: RUN_OUTCOME.FAILED,
    executionId,
    streamId,
    agentName: config.agent,
    category,
    isSubagent,
    error: { kind: classifyAgentError(err), message },
  });
  attachErrorPresentationClaimed(err);
  if (
    !streamStatus.transitionToTerminal(
      streamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    )
  ) {
    runTrace.trace.warn('Failed to mark the launch failure terminal', {
      data: {
        agentIdentifier: config.agent,
        streamId,
      },
    });
  }
}

/**
 * Resolves agent context and reserves the final stream id before the run
 * starts.
 *
 * Treats the `run.start` emission as a transactional commit point: resolution
 * failures before that point release the lock silently; failures after end
 * the started stream via {@link compensateStartedFailure}. A resume passes
 * `streamTabIdOverride`, reserves nothing, and emits `run.activate` alone:
 * its stream already exists for every fold (PRD 6, item 8).
 */
export async function buildAgentLaunchContext(
  input: AgentLaunchInput,
): Promise<AgentLaunchContext> {
  input.signal?.throwIfAborted();
  const { config } = input;
  const launchSession = input.session ?? currentSession();
  const interactions = launchSession.interactions;
  const streamStatus = launchSession.status;
  const executionId = input.executionId;
  // One mint of this run's stream id: an override is used as-is (resume
  // paths pass the streamId stamped on execution metadata), and otherwise
  // the freshly minted id is both the reservation and the run's identity.
  const streamId =
    input.streamTabIdOverride ?? getStreamTabId(config.agent, { executionId });
  const reservedStreamId = input.streamTabIdOverride ? undefined : streamId;
  if (reservedStreamId) {
    acquireStreamOrThrow(reservedStreamId, streamStatus);
  }

  // LIFO ownership of everything assembled before the runtime accepts the
  // launch. Entries register in creation order, so a failed launch unwinds:
  // parent stage end → started-failure compensation (before the trace it
  // logs into is disposed) → run trace detach/dispose → model handler dispose.
  const resources = new DisposableStore();
  const launchFailure: { error?: unknown } = {};
  let started = false;
  try {
    const ctx = await assembleAgentLaunchContext(
      { ...input, session: launchSession },
      executionId,
      streamId,
      resources,
      (runTrace, category) => {
        started = true;
        resources.add(() =>
          compensateStartedFailure({
            config,
            category,
            executionId,
            streamId,
            isSubagent: input.isSubagent ?? false,
            runTrace,
            streamStatus,
            err: launchFailure.error,
          }),
        );
      },
    );
    // The runtime accepted the launch: the returned context and its run
    // lifecycle now own these resources.
    resources.move();
    return ctx;
  } catch (err) {
    launchFailure.error = err;
    try {
      resources.dispose();
    } catch (cleanupError) {
      logger.warn('Failed to release launch resources after a failed launch', {
        data: { error: cleanupError },
      });
    }
    if (!started && reservedStreamId) {
      // The stream never existed (no `run.start`): release the reserved
      // stream lock silently.
      streamStatus.releaseIfReserved(reservedStreamId);
    }
    if (
      !input.suppressErrorNotification &&
      !(err instanceof ZodError) &&
      !hasErrorPresentationClaimed(err)
    ) {
      interactions.emit(
        'requestShowError',
        { message: toErrorMessage(err) },
        { replayWhenAttached: true },
      );
    }
    throw err;
  }
}
