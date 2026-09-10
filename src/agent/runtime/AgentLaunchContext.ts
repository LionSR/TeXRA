import * as path from 'node:path';

import { Cause, Effect, Exit } from 'effect';
import { ZodError } from 'zod';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { isRemoteAgent, resolveAgentForLaunch } from '@agent/index';
import {
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
import {
  ModelHandlerCompatibilityKeySchema,
  type ModelHandlerCompatibilityKey,
} from '@agent/runtime/modelHandlerCompatibilityKey';
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
import {
  aggregateId as qualifyAggregateId,
  type AgentSource,
  type ExecutionId,
  type StreamTabId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import {
  AgentCategory,
  INSTRUCTION_ACTION,
  RUN_OUTCOME,
  STREAM_PHASE,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { createRunTrace, type RunTrace } from '@transcript';
import { isObject, linkAbortSignals } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { createRunContext, runInSession, withRunContext } from './RunContext';
import { createRunScope } from './RunScope';
import { mediaNeedsVisionWarning } from './mediaVisionWarning';
import { getStreamTabId } from './streamTab';
import type { SessionHandle } from './SessionHandle';
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
  definition: PreparedAgentDefinition;
  executionId: ExecutionId;
  streamTabIdOverride?: StreamTabId;
  /**
   * Fires once the stream's `run.start` is published, before the run itself
   * begins: the stream exists for every fold by then, so a host may select
   * it (its own surface state, never a fact) and approval ancestry may be
   * registered against it. It carries the run's trace, which has emitted
   * nothing yet: a consumer of every trace event (the agent package)
   * attaches here, ahead of the instruction log, the root stage, and the
   * launch warnings.
   */
  onStreamResolved?: (streamId: StreamTabId, trace: AgentTrace) => void;
  /** Delegated child of another run; carried on the failure `result`. */
  isSubagent?: boolean;
  /** Stream this run was launched from, stamped on `run.start`. */
  parentStreamId?: StreamTabId;
  /** A workflow-script run's resume anchor, stamped on `run.start`
   *  (decision 9): the checkpoint it journals into. */
  checkpointId?: string;
  /** Runtime behavior declared by the launch source, stamped on `run.start`. */
  userFollowUpSupport?: UserFollowUpSupport;
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

/** Fail the effect with an `Error` when the launch signal has aborted. */
const failIfAborted = (signal: AbortSignal | undefined) =>
  Effect.try({
    try: () => signal?.throwIfAborted(),
    catch: ensureError,
  });

export function withExecutionRunContext<T>(
  ctx: AgentLaunchContext,
  options: { onApprovalPolicyDenial?: () => void } = {},
  fn: () => T,
): T {
  // Single owner of the launch-context → ambient-context mapping. The
  // tool-policy fields (`approvalPromptsUnavailable`, `runtimeUnavailableTools`,
  // `stopAfterCycle`) are projected straight from `ctx.toolPolicy` so callers
  // can't drift a hand-maintained copy of the same values; only
  // `onApprovalPolicyDenial` (a callback that is not part of ToolPolicy) is
  // still supplied explicitly. Run identity (`streamId`/`executionId`/
  // `agentName`/`workingDirectory`) travels via `ctx.runScope` unchanged, and
  // the model via the run's `ModelCell`, so tools observe a mid-session model
  // switch without depending on the `AgentConfig.model` mirror.
  return withRunContext(
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
    { agentName: agentIdentifier, category },
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

const inferLaunchModelHandlerCompatibilityKey = Effect.fn(
  'inferLaunchModelHandlerCompatibilityKey',
)(function* (executionId: ExecutionId, session: SessionHandle) {
  const flowRecord = yield* Effect.tryPromise({
    try: async () =>
      runInSession(session, () =>
        getExecutionStore(executionId).read<FlowRecord>(flowKey(executionId)),
      ),
    catch: ensureError,
  });
  const shared = flowRecord?.shared;
  if (!isObject(shared)) return undefined;
  // Records are stamped at write time, so a record without a key is malformed
  // rather than old.
  const parsed = ModelHandlerCompatibilityKeySchema.nullish().safeParse(
    shared.modelHandlerCompatibilityKey,
  );
  return parsed.success ? (parsed.data ?? undefined) : undefined;
});

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
 * transcript. See .agents/docs/archived/bug-fix/2026-05-30-progress-grouping-refactor.md (R1).
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

function notifyLaunchFailure(
  error: unknown,
  input: { session: SessionHandle; suppressErrorNotification?: boolean },
): void {
  if (
    !input.suppressErrorNotification &&
    !(error instanceof ZodError) &&
    !hasErrorPresentationClaimed(error)
  ) {
    input.session.interactions.emit(
      'requestShowError',
      { message: toErrorMessage(error) },
      { replayWhenAttached: true },
    );
  }
}

export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (
    input: {
      config: AgentConfig;
      enforceCategory?: boolean;
      signal?: AbortSignal;
      suppressErrorNotification?: boolean;
    } & { session: SessionHandle },
  ) {
    yield* failIfAborted(input.signal);
    const fullConfig = input.config;
    const interactions = input.session.interactions;
    // Resolve by the source the delegation captured at validation time, so launch
    // lands on the exact entry validation/display resolved. When no source is
    // pinned (direct launches, restored records), resolution falls to the
    // category-scoped rule validation uses; never blind name resolution.
    const resolution = yield* Effect.tryPromise({
      try: async () =>
        runInSession(input.session, () =>
          getAgentPath(
            fullConfig.agent,
            interactions,
            fullConfig.agentCategory,
            fullConfig.agentSource,
          ),
        ),
      catch: ensureError,
    });
    yield* failIfAborted(input.signal);
    // `loadAgentSettingAndPrompts` already fills the built-in tool-use category
    // default before parsing, and `AgentSettingSchema` prefaults `agentCategory`
    // (to Workflow when absent), so `setting.agentCategory` is always populated
    // here; a second defaulting pass would be a guaranteed no-op.
    const [setting, prompt] = yield* Effect.tryPromise({
      try: async () =>
        runInSession(input.session, () =>
          loadAgentSettingAndPrompts(resolution),
        ),
      catch: ensureError,
    });
    yield* failIfAborted(input.signal);

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
      return yield* Effect.fail(
        new AgentError(
          `Agent '${fullConfig.agent}' is a ${setting.agentCategory} agent but was launched as ${fullConfig.agentCategory}. Use ${suggestion} instead.`,
        ),
      );
    }

    const config: AgentConfig = {
      ...fullConfig,
      agentCategory: setting.agentCategory,
    };
    return { config, setting, prompt, resolution };
  },
  (effect, input) =>
    effect.pipe(
      Effect.onError((cause) =>
        Effect.sync(() => notifyLaunchFailure(Cause.squash(cause), input)),
      ),
    ),
);
export type PreparedAgentDefinition = Effect.Success<
  ReturnType<typeof prepareAgentDefinition>
>;

const assembleAgentLaunchContext = Effect.fn('assembleAgentLaunchContext')(
  function* (
    input: AgentLaunchInput & { session: SessionHandle },
    executionId: ExecutionId,
    streamId: StreamTabId,
    resources: Array<() => void | Promise<void>>,
  ): Effect.fn.Return<AgentLaunchContext, Error> {
    yield* failIfAborted(input.signal);
    const { config, setting, prompt, resolution } = input.definition;
    const interactions = input.session.interactions;
    const modelConfig = yield* Effect.tryPromise({
      try: async () =>
        runInSession(input.session, () =>
          validateModelExists(config.model, interactions),
        ),
      catch: ensureError,
    });
    yield* failIfAborted(input.signal);

    // The session is resolved once at the boundary (buildAgentLaunchContext)
    // and carried in, so a delegated launch inherits the parent run's session
    // policy and a root launch gets the process default exactly once.
    const session = input.session;
    const modelHandlerCompatibilityKey =
      input.modelHandlerCompatibilityKey ??
      (yield* inferLaunchModelHandlerCompatibilityKey(executionId, session));
    yield* failIfAborted(input.signal);
    const modelHandler = yield* Effect.tryPromise({
      try: async () =>
        runInSession(session, () =>
          modelHandlerCompatibilityKey
            ? createModelHandlerForCompatibilityKey(
                modelConfig,
                modelHandlerCompatibilityKey,
                session.responseTextProcessing,
              )
            : createModelHandler(
                modelConfig,
                session.responseTextProcessing,
                input.copilotRouteOverride,
              ),
        ),
      catch: ensureError,
    });
    resources.push(() => modelHandler.dispose());
    yield* failIfAborted(input.signal);
    const modelCell = new ModelCell(modelHandler, config.model);

    const residency = yield* session.transcripts.acquireRunResidency(
      streamId,
      executionId,
    );
    const rawRunTrace = createRunTrace(residency);
    // The composed trace enters the store BEFORE session attachment, so a
    // failed attachment still disposes the raw trace through the store.
    const attachment: { detach?: () => void } = {};
    const runTrace: RunTrace = {
      trace: rawRunTrace.trace,
      dispose: () => {
        try {
          attachment.detach?.();
        } finally {
          rawRunTrace.dispose();
        }
      },
    };
    resources.push(() => runTrace.dispose());
    yield* failIfAborted(input.signal);
    attachment.detach = session.attachRunTrace(rawRunTrace.trace, streamId);

    const agentLogger = runTrace.trace;
    modelHandler.setAgentCategory(setting.agentCategory);
    modelHandler.setLogger(agentLogger);

    yield* failIfAborted(input.signal);
    const isRemote = isRemoteAgent(config.agent);
    // Registration committed creation, configuration and initial activation.
    // A resumed turn appends only its new activation.
    const background = input.isSubagent ?? false;
    if (input.streamTabIdOverride) {
      yield* session.commit([
        {
          type: 'run.activate',
          aggregateId: qualifyAggregateId('stream', streamId),
          category: setting.agentCategory,
          isRemote,
          background,
        },
      ]);
    }

    yield* Effect.tryPromise({
      try: () => session.settlePublications(),
      catch: ensureError,
    });
    input.onStreamResolved?.(streamId, runTrace.trace);

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
    resources.push(() => parentStage.end(RUN_OUTCOME.FAILED));

    // Tell the user when attached images will be dropped because the chosen model
    // lacks vision. The downstream initializeMessages/addMediaToUserMessage guards
    // drop them silently otherwise.
    const visionWarning = mediaNeedsVisionWarning(
      config.mediaFiles,
      modelHandler.capabilities,
      'attached',
      config.model,
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
    const detachRunAbortLink = linkAbortSignals(
      [input.signal],
      runAbortController,
    );
    resources.push(detachRunAbortLink);
    const runSignal = runAbortController.signal;
    const runScope = createRunScope({
      streamId,
      executionId,
      agentName: config.agent,
      workingDirectory,
      delegationAgentScope: config.delegationAgentScope,
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

    const baseVars = yield* Effect.tryPromise({
      try: async () =>
        runInSession(session, () =>
          setting.agentCategory === AgentCategory.ToolUse
            ? buildVars()
            : parentStage.child('Init').run(buildVars),
        ),
      catch: ensureError,
    });
    yield* failIfAborted(input.signal);

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
  },
);

/** Resolve the context of a run already admitted and created by registration. */
export const buildAgentLaunchContext = Effect.fn('buildAgentLaunchContext')(
  function* (input: AgentLaunchInput & { session: SessionHandle }) {
    yield* failIfAborted(input.signal);
    const { session: launchSession, executionId } = input;
    const { config } = input.definition;
    const streamStatus = launchSession.status;
    const streamId =
      input.streamTabIdOverride ??
      getStreamTabId(config.agent, { executionId });

    // The runtime takes these resources only after assembly succeeds. Failure
    // unwinds them in reverse order while preserving the original cause.
    const resources: Array<() => void | Promise<void>> = [];
    return yield* assembleAgentLaunchContext(
      input,
      executionId,
      streamId,
      resources,
    ).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const err = Cause.squash(cause);
          const message = `Failed to start agent ${config.agent}: ${getSdkErrorMessage(err)}`;
          launchSession.publishRunEvent(streamId, {
            type: 'result',
            outcome: RUN_OUTCOME.FAILED,
            executionId,
            streamId,
            agentName: config.agent,
            category: config.agentCategory,
            isSubagent: input.isSubagent ?? false,
            error: { kind: classifyAgentError(err), message },
          });
          streamStatus.transitionToTerminal(
            streamId,
            STREAM_PHASE.FAILED,
            STREAM_TRANSITION_CAUSE.LIFECYCLE,
          );
          const publication = yield* Effect.exit(
            Effect.tryPromise({
              try: () => launchSession.settlePublications(),
              catch: ensureError,
            }),
          );
          if (Exit.isFailure(publication))
            logger.warn('Failed to publish launch failure', {
              data: Cause.squash(publication.cause),
            });
          const failures: unknown[] = [];
          for (const dispose of resources.toReversed()) {
            const disposed = yield* Effect.exit(
              Effect.tryPromise({
                try: async () => dispose(),
                catch: ensureError,
              }),
            );
            if (Exit.isFailure(disposed))
              failures.push(Cause.squash(disposed.cause));
          }
          if (failures.length) {
            logger.warn(
              'Failed to release launch resources after a failed launch',
              {
                data: {
                  error: new AggregateError(failures, 'Launch cleanup failed'),
                },
              },
            );
          }
          notifyLaunchFailure(err, input);
        }),
      ),
    );
  },
  // The existing launch signal owns cancellation. Let each acquisition settle
  // before cleanup so a late Promise cannot create an unowned resource.
  Effect.uninterruptible,
);
