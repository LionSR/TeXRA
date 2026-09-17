import * as path from 'node:path';

import { Cause, Deferred, Effect, Exit } from 'effect';
import { ZodError } from 'zod';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { isRemoteAgent, resolveAgentForLaunch } from '@agent/index';
import {
  logUserMessage,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type { AgentEntry } from '@agent/index/agentEntry';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { getDisplayedInstruction } from '@agent/runtime/sessionDescription';
import { buildUserVars } from '@agent/prompt/userVars';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { AgentError, classifyAgentError } from '@common/errors';
import {
  attachErrorPresentationClaimed,
  hasErrorPresentationClaimed,
} from '@common/errors/sdkError/errorMetadata';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import {
  aggregateId as qualifyAggregateId,
  type AgentSource,
  type AttachedMemoryMiss,
  type ModelCompatibilityKey,
  type RunId,
  type UserVariableChannels,
} from '@shared/schemas';
import {
  AgentCategory,
  INSTRUCTION_ACTION,
  RUN_OUTCOME,
} from '@shared/schemas';
import { createRunTrace, type RunTrace } from '@transcript';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { runInSession } from './RunContext';
import { mediaNeedsVisionWarning } from './mediaVisionWarning';
import type { RunScope } from './RunScope';
import type { SessionHandle } from './SessionHandle';
import type { SessionHostInteractions } from './HostInteractions';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

const logger = createLog('AgentLaunchContext');

/**
 * Immutable per-run tool policy, read from the run's `AgentRun` service.
 *
 * A frozen value the loop takes from context runs without an
 * `AsyncLocalStorage` frame — the property an SDK embedder wants.
 */
export interface ToolPolicy {
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Stop a tool-use run after one model/tool cycle instead of waiting. */
  readonly stopAfterCycle?: boolean;
}

export interface AgentLaunchContext {
  /** Run identity and owning session. */
  readonly runScope: RunScope;
  /**
   * The registry config of the launch model. The run's `AgentRun` service
   * binds it (or the model a resumed run's snapshot names) under the route
   * `modelCompatibilityKey` records; a mid-run switch rebinds there.
   */
  readonly modelConfig: ModelConfig;
  /**
   * The conversation format a resumed run persisted, or null for a fresh run
   * whose route the binding resolves from today's settings.
   */
  readonly modelCompatibilityKey: ModelCompatibilityKey | null;
  /**
   * This launch is the user's own-API-key fallback: the retry they answered
   * that way relaunched the run here, so it declines the editor's Copilot
   * route and every subscription route the run's bindings could take. The
   * user's stored preferences are not touched; the choice is the run's.
   */
  readonly ownApiKeyFallback: boolean;
  /** Immutable per-run tool policy. */
  readonly toolPolicy: ToolPolicy;
  /**
   * The process secret store and global state the launch read from its
   * `Secrets` / `AppState` services, so every Promise-tier read below the
   * launch (routing, credentials, tool availability) uses the same stores.
   */
  readonly stores: ModelOptionStores;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  logger: AgentTrace;
  userVarChannels: UserVariableChannels;
  /** Initial user row to log after the loop has inserted launch media. */
  initialUserMessageForTranscript?: string;
  /** Description from the exact registry entry selected for this launch. */
  resolvedAgentDescription?: string;
  usageMonitor: UsageMonitor;
  parentStage: StageHandle;
  attachedMemoryMisses: AttachedMemoryMiss[];
  /**
   * The run's one stop. Every stop entry — a host kill through the run
   * handle, the live tool-use flow context, the launch handle's interrupt
   * before the run has a handle of its own — completes
   * {@link AgentLaunchContext.stopped}, and the run's program is interrupted
   * from it. Nothing else stops a run.
   */
  interrupt: () => void;
  /**
   * Completed by {@link AgentLaunchContext.interrupt}. The runner races it
   * once, at the boundary that owns the run's program, so a stop reaches the
   * loop as a fiber interruption whose finalizers record the halt.
   */
  readonly stopped: Deferred.Deferred<void>;
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
  runId: RunId;
  /**
   * The run's `run.start` was committed by an earlier activation: this
   * launch resumes it, so it appends its own `run.activate` and does not
   * log the initial instruction again.
   */
  resumed?: boolean;
  /**
   * Fires once the run's `run.start` is published, before the run itself
   * begins: the run exists for every fold by then, so a host may select
   * it (its own surface state, never a fact) and approval ancestry may be
   * registered against it. It carries the run's trace, which has emitted
   * nothing yet: a consumer of every trace event (the agent package)
   * attaches here, ahead of the instruction log, the root stage, and the
   * launch warnings.
   */
  onRunResolved?: (runId: RunId, trace: AgentTrace) => void;
  /** Session owning this run's coordination state; every launch supplies it. */
  session?: SessionHandle;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelCompatibilityKey?: ModelCompatibilityKey | null;
  /** This launch is the user's own-API-key fallback for a quota-exhausted
   *  retry: it declines the Copilot route and every subscription route. */
  ownApiKeyFallback?: boolean;
  /**
   * The launch's stop latch, adopted as the run's own
   * {@link AgentLaunchContext.stopped}: once completed, assembly fails at its
   * next step and the run it has already assembled is stopped.
   */
  stopped?: Deferred.Deferred<void>;
  /** Immutable per-run tool policy carried on the launch context for cycle flows. */
  toolPolicy?: ToolPolicy;
}

/** Fail the effect with an `Error` when the launch signal has aborted. */
const failIfAborted = (signal: AbortSignal | undefined) =>
  Effect.try({
    try: () => signal?.throwIfAborted(),
    catch: ensureError,
  });

/**
 * Fail with an `AbortError` once a launch's stop latch has been completed.
 * A launch prepares uninterruptibly, so every acquisition settles before its
 * cleanup; these checks between its steps are where a stop ends it.
 */
export const failIfLaunchStopped = (
  stopped: Deferred.Deferred<void> | undefined,
): Effect.Effect<void, Error> =>
  Effect.suspend(() =>
    stopped !== undefined && Deferred.isDoneUnsafe(stopped)
      ? Effect.fail(new DOMException('The launch was stopped.', 'AbortError'))
      : Effect.void,
  );

/**
 * Present a launch error through its targeted host notice (replayed if no
 * host is attached yet) and throw it claimed: the notice is its one surface,
 * so the launch catch adds no generic toast. No run exists yet, so a host
 * that throws on the notice, live or on replay (a renderer torn down
 * mid-post, #10398/#10466), shows the generic toast in its place.
 */
function presentLaunchError<K extends RuntimePresentationEvent>(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  err: AgentError,
  event: K,
  payload: RuntimePresentationEventPayloads[K],
): never {
  interactions.emit(event, payload, {
    replayWhenAttached: true,
    fallbackMessage: toErrorMessage(err),
  });
  attachErrorPresentationClaimed(err);
  throw err;
}

async function getAgentPath(
  agentIdentifier: string,
  interactions: Pick<SessionHostInteractions, 'emit'>,
  category: AgentCategory,
  source?: AgentSource | null,
): Promise<AgentEntry> {
  // Single launch resolution rule (see resolveAgentForLaunch): exact
  // (source, name) when the delegation pinned one, else the same visible-set
  // resolver validation uses, else the full set for internal agents. Never
  // blind source-priority on a bare name, so launch can't diverge from
  // what was validated.
  const result = resolveAgentForLaunch(category, agentIdentifier, source);
  if (result) return result;

  return presentLaunchError(
    interactions,
    new AgentError(`Could not find agent: ${agentIdentifier}`),
    'showAgentConfigBanner',
    { agentName: agentIdentifier, category },
  );
}

const validateModelExists = Effect.fn('AgentLaunchContext.validateModelExists')(
  function* (
    modelName: string,
    interactions: Pick<SessionHostInteractions, 'emit'>,
  ) {
    const modelConfig = yield* resolveRuntimeModelConfig(modelName);
    if (modelConfig) return modelConfig;

    return yield* Effect.try({
      try: () =>
        presentLaunchError(
          interactions,
          new AgentError(`Model ${modelName} is not registered`),
          'requestShowInstruction',
          {
            key: 'modelNotRecognized',
            message: `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
            actions: [INSTRUCTION_ACTION.OPEN_MODELS_DOC],
            showSuppress: false,
          },
        ),
      catch: ensureError,
    });
  },
);

/**
 * The conversation format a resumed run's rows are in, read off its latest
 * `flow.snapshot` (the one indexed read); a run with no snapshot has no
 * persisted format and binds today's default route.
 */
const inferLaunchModelCompatibilityKey = Effect.fn(
  'inferLaunchModelCompatibilityKey',
)(function* (runId: RunId, session: SessionHandle) {
  const snapshot = yield* session.ledger.latestSnapshot(runId);
  if (snapshot === null) return undefined;
  return snapshot.payload.runtime.modelCompatibilityKey ?? undefined;
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

export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (
    input: {
      config: AgentConfig;
      enforceCategory?: boolean;
      signal?: AbortSignal;
      /** The launch handle's stop latch; checked between async steps. */
      stopped?: Deferred.Deferred<void>;
      suppressErrorNotification?: boolean;
    } & { session: SessionHandle },
  ) {
    yield* failIfAborted(input.signal);
    yield* failIfLaunchStopped(input.stopped);
    const fullConfig = input.config;
    const interactions = input.session.interactions;
    // Resolve by the source the delegation captured at validation time, so launch
    // lands on the exact entry validation/display resolved. When no source is
    // pinned (direct launches, restored records), resolution falls to the
    // category-scoped rule validation uses; never blind name resolution.
    const agentEntry = yield* Effect.tryPromise({
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
    yield* failIfLaunchStopped(input.stopped);
    // `loadAgentSettingAndPrompts` already fills the built-in tool-use category
    // default before parsing, and `AgentSettingSchema` prefaults `agentCategory`
    // (to Workflow when absent), so `setting.agentCategory` is always populated
    // here; a second defaulting pass would be a guaranteed no-op. The load reads
    // nothing from the run's ALS frame (absolute paths, the registry cache, the
    // remote fetch), so it yields directly rather than entering `runInSession`.
    const [setting, prompt] = yield* loadAgentSettingAndPrompts(agentEntry);
    yield* failIfAborted(input.signal);
    yield* failIfLaunchStopped(input.stopped);

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

    // Validated before registration, so a typo'd model name registers no
    // FAILED execution and surfaces only its targeted instruction.
    const modelConfig = yield* validateModelExists(
      fullConfig.model,
      interactions,
    );
    yield* failIfAborted(input.signal);
    yield* failIfLaunchStopped(input.stopped);

    const config: AgentConfig = {
      ...fullConfig,
      agentCategory: setting.agentCategory,
    };
    return { config, setting, prompt, agentEntry, modelConfig };
  },
  // No run exists yet, so no `result` event will present this failure: the
  // generic toast is its one surface. Once assembly begins, the terminal
  // `result` event is the only presentation.
  (effect, input) =>
    effect.pipe(
      Effect.onError((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause);
          if (
            input.suppressErrorNotification ||
            error instanceof ZodError ||
            hasErrorPresentationClaimed(error)
          ) {
            return;
          }
          input.session.interactions.emit(
            'requestShowError',
            { message: toErrorMessage(error) },
            { replayWhenAttached: true },
          );
        }),
      ),
    ),
);
export type PreparedAgentDefinition = Effect.Success<
  ReturnType<typeof prepareAgentDefinition>
>;

const assembleAgentLaunchContext = Effect.fn('assembleAgentLaunchContext')(
  function* (
    input: AgentLaunchInput & { session: SessionHandle },
    runId: RunId,
    resources: Array<() => void | Promise<void>>,
  ): Effect.fn.Return<AgentLaunchContext, Error, Secrets | AppState> {
    yield* failIfLaunchStopped(input.stopped);
    const { config, setting, prompt, agentEntry, modelConfig } =
      input.definition;

    // The session is resolved once at the boundary (buildAgentLaunchContext)
    // and carried in, so a delegated launch inherits the parent run's session
    // policy and a root launch gets the process default exactly once.
    const session = input.session;
    const modelCompatibilityKey =
      input.modelCompatibilityKey ??
      (yield* inferLaunchModelCompatibilityKey(runId, session)) ??
      null;
    yield* failIfLaunchStopped(input.stopped);
    // The run's model is bound from the process stores the launch already
    // has in scope, so routing and key availability read the same secret
    // store and global state the rest of the run does.
    const stores: ModelOptionStores = {
      secrets: yield* Secrets,
      globalState: yield* AppState,
    };

    const residency = yield* session.transcripts.acquireRunResidency(runId);
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
    yield* failIfLaunchStopped(input.stopped);
    attachment.detach = session.attachRunTrace(rawRunTrace.trace, runId);

    const agentLogger = runTrace.trace;

    yield* failIfLaunchStopped(input.stopped);
    const isRemote = isRemoteAgent(config.agent);
    // Registration committed creation, configuration and initial activation,
    // each awaited; a resumed turn appends only its new activation, awaited
    // here. Both are durable before the run resolves, so this path drains
    // nothing: a barrier over the run's publications would answer for facts
    // the run's own fibers queued, and their loss is the terminal drain's to
    // report on the row it decides.
    if (input.resumed) {
      yield* session.commit([
        {
          type: 'run.activate',
          aggregateId: qualifyAggregateId('run', runId),
          category: setting.agentCategory,
          isRemote,
        },
      ]);
    }

    input.onRunResolved?.(runId, runTrace.trace);

    // Log the initial instruction as a user message so both workflow and
    // tool-use tabs display it inline with the stream log (no separate panel).
    const displayInstruction = getDisplayedInstruction(config);
    const initialInstruction =
      displayInstruction && !input.resumed ? displayInstruction : undefined;
    const supportsMediaInMessage =
      setting.agentCategory === AgentCategory.ToolUse
        ? modelConfig.capabilities.supportsVision ||
          modelConfig.capabilities.supportsNativeAudio
        : modelConfig.capabilities.supportsVision;
    const initialMediaMayBeInserted =
      config.mediaFiles.length > 0 && supportsMediaInMessage;

    const parentStage = beginRunStage(
      agentLogger,
      `Run: ${config.agent}`,
      initialMediaMayBeInserted ? undefined : initialInstruction,
    );
    resources.push(() => parentStage.end(RUN_OUTCOME.FAILED));

    // Tell the user when attached images will be dropped because the chosen model
    // lacks vision. The loop's media input skips them with a per-file warning
    // otherwise.
    const visionWarning = mediaNeedsVisionWarning(
      config.mediaFiles,
      modelConfig.capabilities,
      'attached',
      config.model,
    );
    if (visionWarning) agentLogger.warn(visionWarning);

    const agentPath = path.dirname(agentEntry.path);
    const workingDirectory = config.workingDirectory?.trim() || undefined;
    // The run's one stop. `interrupt()` completes it; the runner races it and
    // the program is interrupted from it. A launch that already owns a stop
    // hands it in, so a stop that landed while the launch prepared is this
    // run's stop too.
    const stopped = input.stopped ?? Deferred.makeUnsafe<void>();
    const stopRun = () => {
      Deferred.doneUnsafe(stopped, Effect.void);
    };
    // Frozen here, at the run's one real construction site: a run's identity
    // and owning session must not change under the loop that reads them, and
    // `readonly` alone stops only the callers that kept their types.
    const runScope: RunScope = Object.freeze({
      runId,
      workingDirectory,
      delegationAgentScope: config.delegationAgentScope,
      session,
    });
    const buildVars = (stageId?: string) =>
      buildUserVars(
        config,
        setting,
        prompt,
        agentPath,
        {
          isOpenai: modelConfig.provider === ModelProvider.OPENAI,
          isAnthropic: modelConfig.provider === ModelProvider.ANTHROPIC,
          isGoogle: modelConfig.provider === ModelProvider.GOOGLE,
        },
        agentLogger,
        {
          // The session's own root, handed to prompt assembly as data: file
          // names, readable-file reads and CWD resolve against this project's
          // folder rather than whatever roots the calling fiber carries.
          workspacePath: session.roots.workspace,
          delegationAgentScope: runScope.delegationAgentScope,
          stageId,
        },
      );

    const baseVars = yield* Effect.tryPromise({
      try: async () =>
        runInSession(session, async () => {
          if (setting.agentCategory === AgentCategory.ToolUse) {
            return buildVars();
          }

          const initStage = parentStage.child('Init');
          return buildVars(initStage.id).then(
            (vars) => {
              initStage.end(RUN_OUTCOME.COMPLETED);
              return vars;
            },
            (error) => {
              initStage.end(RUN_OUTCOME.FAILED);
              throw error;
            },
          );
        }),
      catch: ensureError,
    });
    yield* failIfLaunchStopped(input.stopped);

    const userVarChannels: UserVariableChannels = { ...baseVars };
    const attachedMemoryMisses = baseVars.ATTACHED_MEMORY_MISSES;

    const usageMonitor = new UsageMonitor(
      {
        logger: agentLogger,
        runId,
        runStageId: parentStage.id,
        config: session.roots.config,
      },
      {
        agentName: config.agent,
        agentCategory: setting.agentCategory,
      },
    );
    return {
      config,
      resolvedAgentDescription: agentEntry.description,
      setting,
      prompt,
      modelConfig,
      modelCompatibilityKey,
      ownApiKeyFallback: input.ownApiKeyFallback ?? false,
      // Frozen so nothing mutates it mid-run; `Object.freeze` is shallow, so
      // the nested tool-name array gets its own frozen copy rather than
      // aliasing the caller's (still mutable) array.
      toolPolicy: Object.freeze({
        ...input.toolPolicy,
        runtimeUnavailableTools: input.toolPolicy?.runtimeUnavailableTools
          ? Object.freeze([...input.toolPolicy.runtimeUnavailableTools])
          : undefined,
      }),
      stores,
      logger: agentLogger,
      parentStage,
      userVarChannels,
      attachedMemoryMisses,
      usageMonitor,
      runScope,
      interrupt: stopRun,
      stopped,
      initialUserMessageForTranscript: initialMediaMayBeInserted
        ? initialInstruction
        : undefined,
      disposeTrace: () => runTrace.dispose(),
    };
  },
);

/** Resolve the context of a run already admitted and created by registration. */
export const buildAgentLaunchContext = Effect.fn('buildAgentLaunchContext')(
  function* (input: AgentLaunchInput & { session: SessionHandle }) {
    yield* failIfLaunchStopped(input.stopped);
    const { session: launchSession, runId } = input;
    const { config } = input.definition;

    // The runtime takes these resources only after assembly succeeds. Failure
    // unwinds them in reverse order while preserving the original cause.
    const resources: Array<() => void | Promise<void>> = [];
    return yield* assembleAgentLaunchContext(input, runId, resources).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const err = Cause.squash(cause);
          const message = `Failed to start agent ${config.agent}: ${getSdkErrorMessage(err)}`;
          const finalization = yield* finalizeRun(launchSession, {
            runId,
            outcome: RUN_OUTCOME.FAILED,
            error: { kind: classifyAgentError(err), message },
          });
          // `finalizeRun` commits the terminal row awaited and reports its
          // own refusal, so this path has nothing left queued to wait on. A
          // drain here would take the run's other in-flight facts out of the
          // tracked set and warn over them, which is how a lost run fact
          // stops reaching the row that should carry it.
          if (!finalization.ok)
            logger.warn('Failed to persist the launch failure', {
              data: finalization.error,
            });
          const disposals = yield* Effect.forEach(
            resources.toReversed(),
            (dispose) =>
              Effect.exit(
                Effect.tryPromise({
                  try: async () => dispose(),
                  catch: ensureError,
                }),
              ),
          );
          const failures = disposals.flatMap((disposed) =>
            Exit.isFailure(disposed) ? [Cause.squash(disposed.cause)] : [],
          );
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
        }),
      ),
    );
  },
  // The launch's stop latch owns cancellation. Let each acquisition settle
  // before cleanup so a late Promise cannot create an unowned resource.
  Effect.uninterruptible,
);
