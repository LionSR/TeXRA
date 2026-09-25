import * as path from 'node:path';

import { Cause, Effect, Exit, FileSystem, Scope } from 'effect';
import { ZodError } from 'zod';
import { MODEL_CONFIGS, ModelProvider, type ModelConfig } from 'llm-zoo';

import { refresh, resolveAgentForLaunch } from '@agent/index';
import {
  logUserMessage,
  TraceEmitter,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
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
import { withLogChannel } from '@logger/effectLog';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import {
  aggregateId as qualifyAggregateId,
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
import { UsageLog } from '@shared/usageLog';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { mediaNeedsVisionWarning } from './mediaVisionWarning';
import type { AgentRunShape, ToolPolicy } from './run/AgentRun';
import type { SessionHandle } from './SessionHandle';
import type { SessionHostInteractions } from './HostInteractions';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

const CHANNEL = 'AgentLaunchContext';

/**
 * The launch facts carried by {@link AgentRunShape}. The run narrows `setting`
 * to its resolved tool list; every other fact reaches it unchanged.
 */
type LaunchResolvedRunFacts = Pick<
  AgentRunShape,
  | 'runId'
  | 'session'
  | 'workingDirectory'
  | 'delegationAgentScope'
  | 'config'
  | 'setting'
  | 'prompt'
  | 'logger'
  | 'parentStage'
  | 'toolPolicy'
  | 'stores'
  | 'userVarChannels'
  | 'initialUserMessageForTranscript'
  | 'usageMonitor'
>;

export interface AgentLaunchContext extends LaunchResolvedRunFacts {
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
  /** Description from the exact registry entry selected for this launch. */
  readonly resolvedAgentDescription?: string;
  readonly attachedMemoryMisses: AttachedMemoryMiss[];
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
  /** Immutable per-run tool policy carried on the launch context for cycle flows. */
  toolPolicy?: ToolPolicy;
}

/**
 * Present a launch error through its targeted host notice (replayed if no
 * host is attached yet) and fail with it claimed: the notice is its one
 * surface, so the launch catch adds no generic toast. No run exists yet, so a
 * host that throws on the notice, live or on replay (a renderer torn down
 * mid-post, #10398/#10466), shows the generic toast in its place.
 */
function presentLaunchError<K extends RuntimePresentationEvent>(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  err: AgentError,
  event: K,
  payload: RuntimePresentationEventPayloads[K],
): Effect.Effect<never, AgentError> {
  return interactions
    .emit(event, payload, {
      replayWhenAttached: true,
      fallbackMessage: toErrorMessage(err),
    })
    .pipe(
      Effect.andThen(
        Effect.suspend(() => {
          attachErrorPresentationClaimed(err);
          return Effect.fail(err);
        }),
      ),
    );
}

const validateModelExists = Effect.fn('AgentLaunchContext.validateModelExists')(
  function* (
    modelName: string,
    interactions: Pick<SessionHostInteractions, 'emit'>,
  ) {
    const modelConfig = MODEL_CONFIGS[modelName];
    if (modelConfig) return modelConfig;

    return yield* presentLaunchError(
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
 * ROOT INVARIANT: a stage parents only to the handle or id its opener names,
 * so this opens as a root — it cannot inherit a stage from a parent run (e.g.
 * an orchestrator's tool-use stage when this is a subagent). That isolation is
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
      suppressErrorNotification?: boolean;
    } & { session: SessionHandle },
  ) {
    const fullConfig = input.config;
    const interactions = input.session.interactions;
    // Single launch resolution rule (see resolveAgentForLaunch): pinned
    // (source, name), else the visible set validation used, else the full
    // category; never blind source-priority on a bare name. A miss rescans the
    // local directories once, so a YAML written since the catalog loaded runs.
    const resolve = resolveAgentForLaunch(
      input.session.roots,
      fullConfig.agentCategory,
      fullConfig.agent,
      fullConfig.agentSource,
    );
    const agentEntry =
      (yield* resolve) ??
      (yield* Effect.andThen(refresh(), resolve)) ??
      (yield* presentLaunchError(
        interactions,
        new AgentError(`Could not find agent: ${fullConfig.agent}`),
        'showAgentConfigBanner',
        {
          agentName: fullConfig.agent,
          category: fullConfig.agentCategory,
        },
      ));
    // `loadAgentSettingAndPrompts` already fills the built-in tool-use category
    // default before parsing, and `AgentSettingSchema` prefaults `agentCategory`
    // (to Workflow when absent), so `setting.agentCategory` is always populated
    // here; a second defaulting pass would be a guaranteed no-op. The load reads
    // nothing from the run's ALS frame (absolute paths, the registry cache, the
    // remote fetch), so it yields directly rather than entering `runInSession`.
    const [setting, prompt] = yield* loadAgentSettingAndPrompts(agentEntry);

    // Block category mismatch. Resolution is already category-scoped; this
    // catches what the registry's pre-merge category can't see: an agent that
    // `inherits` a parent of the other category, or an `agentSource` pinned
    // from a run record. Opt-in: chat roots, the CLI, subagents and resume.
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

    // Stamp the resolved source so the run record carries the decided identity;
    // `agent` stays as the caller spelled it (the resume-id contract).
    const config: AgentConfig = {
      ...fullConfig,
      agentCategory: setting.agentCategory,
      agentSource: agentEntry.source,
    };
    return { config, setting, prompt, agentEntry, modelConfig };
  },
  // No run exists yet, so no `result` event will present this failure: the
  // generic toast is its one surface. Once assembly begins, the terminal
  // `result` event is the only presentation.
  (effect, input) =>
    effect.pipe(
      Effect.onError((cause) =>
        Effect.suspend(() => {
          const error = Cause.squash(cause);
          if (
            input.suppressErrorNotification ||
            error instanceof ZodError ||
            hasErrorPresentationClaimed(error)
          ) {
            return Effect.void;
          }
          return input.session.interactions.emit(
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
  ): Effect.fn.Return<
    AgentLaunchContext,
    Error,
    Secrets | AppState | UsageLog | FileSystem.FileSystem | Scope.Scope
  > {
    const { config, setting, prompt, agentEntry, modelConfig } =
      input.definition;
    // The run's working directory is decided here, once: absolute or absent.
    // Every tool call of the run carries it as `ToolCall.workingDirectory`
    // and trusts it rather than re-validating.
    const workingDirectory = yield* Effect.try({
      try: () => parseWorkingDirectory(config.workingDirectory),
      catch: ensureError,
    });

    // The session is resolved once at the boundary (buildAgentLaunchContext)
    // and carried in, so a delegated launch inherits the parent run's session
    // policy and a root launch gets the process default exactly once.
    const { session, runId } = input;
    const modelCompatibilityKey =
      input.modelCompatibilityKey ??
      (yield* inferLaunchModelCompatibilityKey(runId, session)) ??
      null;
    // The run's model is bound from the stores the launch already has: the
    // session's own setting slots, so routing and the provider switches
    // answer for this run's workspace, and the process secret store.
    const stores: ModelOptionStores = {
      ...session.roots,
      secrets: yield* Secrets,
    };

    const agentLogger = new TraceEmitter();
    // The run's scope owns the trace's session attachment: it is dropped when
    // the run ends, and when a launch that never became a run unwinds.
    yield* Effect.acquireRelease(
      Effect.sync(() => session.attachRunTrace(agentLogger, runId)),
      (detach) => Effect.sync(detach),
    );

    const isRemote = agentEntry.source === 'remote';
    // Registration committed creation, configuration and first activation; a
    // resume appends its activation here, with the approval snapshot that
    // enforcement holds (no `run.start` re-stamps it). Both are durable before
    // the run resolves, so nothing drains here (lost facts are the terminal
    // drain's), and the append is uninterruptible: a stop lands before or after.
    if (input.resumed) {
      const aggregateId = qualifyAggregateId('run', runId);
      const snapshot = session.approvalPolicySnapshotFor(runId);
      yield* Effect.uninterruptible(
        session.commit([
          {
            type: 'run.activate',
            aggregateId,
            category: setting.agentCategory,
            isRemote,
          },
          { type: 'approval.policy', aggregateId, snapshot },
        ]),
      );
    }

    input.onRunResolved?.(runId, agentLogger);

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

    const parentStage = yield* Effect.acquireRelease(
      Effect.sync(() =>
        beginRunStage(
          agentLogger,
          `Run: ${config.agent}`,
          initialMediaMayBeInserted ? undefined : initialInstruction,
        ),
      ),
      // A scope that closes in failure before the run's terminal row closed
      // this stage leaves it open in the transcript; `end` is idempotent, so a
      // run that already published its verdict keeps it.
      (stage, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.sync(() => stage.end(RUN_OUTCOME.FAILED)),
    );

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
    const buildVars = (stageId?: string) =>
      buildUserVars(
        config,
        setting,
        prompt,
        agentPath,
        modelConfig.provider === ModelProvider.ANTHROPIC,
        agentLogger,
        {
          // The session's own root, handed to prompt assembly as data: file
          // names, readable-file reads and CWD resolve against this project's
          // folder rather than whatever roots the calling fiber carries.
          workspacePath: session.roots.workspace,
          storageRoot: session.roots.storage,
          config: session.roots.config,
          settings: session.roots,
          stageId,
        },
      );

    const baseVars = yield* Effect.suspend(() => {
      if (setting.agentCategory === AgentCategory.ToolUse) return buildVars();

      const initStage = parentStage.child('Init');
      return buildVars(initStage.id).pipe(
        Effect.tap(() =>
          Effect.sync(() => initStage.end(RUN_OUTCOME.COMPLETED)),
        ),
        Effect.onError(() =>
          Effect.sync(() => initStage.end(RUN_OUTCOME.FAILED)),
        ),
      );
    });

    const userVarChannels: UserVariableChannels = { ...baseVars };
    const attachedMemoryMisses = baseVars.ATTACHED_MEMORY_MISSES;

    const usageMonitor = new UsageMonitor(
      {
        logger: agentLogger,
        runId,
        runStageId: parentStage.id,
        config: session.roots.config,
        usageLog: yield* UsageLog,
      },
      {
        agentName: config.agent,
        agentCategory: setting.agentCategory,
      },
    );
    const context: AgentLaunchContext = {
      runId,
      session,
      workingDirectory,
      delegationAgentScope: config.delegationAgentScope,
      config,
      resolvedAgentDescription: agentEntry.description,
      setting,
      prompt,
      modelConfig,
      modelCompatibilityKey,
      ownApiKeyFallback: input.ownApiKeyFallback ?? false,
      // Frozen so nothing mutates it mid-run.
      toolPolicy: Object.freeze({ ...input.toolPolicy }),
      stores,
      logger: agentLogger,
      parentStage,
      userVarChannels,
      attachedMemoryMisses,
      usageMonitor,
      initialUserMessageForTranscript: initialMediaMayBeInserted
        ? initialInstruction
        : undefined,
    };
    // Frozen at the run's one real construction site: a run's identity, its
    // owning session, and the rest of what the launch resolved must not change
    // under the loop that reads them, and `readonly` alone stops only the
    // callers that kept their types.
    return Object.freeze(context);
  },
);

/** Resolve the context of a run already admitted and created by registration. */
export const buildAgentLaunchContext = Effect.fn('buildAgentLaunchContext')(
  function* (input: AgentLaunchInput & { session: SessionHandle }) {
    const { session: launchSession, runId } = input;
    const { config } = input.definition;

    return yield* assembleAgentLaunchContext(input).pipe(
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
            yield* Effect.logWarning(
              'Failed to persist the launch failure',
            ).pipe(
              Effect.annotateLogs({ data: finalization.error }),
              withLogChannel(CHANNEL),
            );
        }),
      ),
    );
  },
  // Interruptible: every acquisition above settles atomically inside its own
  // `acquireRelease`, so an interruption lands between steps and the scope's
  // finalizers release whatever was acquired — the guarantee the old region
  // mask bought at the cost of suppressing every stop.
);
