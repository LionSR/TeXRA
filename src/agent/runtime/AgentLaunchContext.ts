import * as path from 'node:path';

import { Cause, Effect, Exit, FileSystem, Scope } from 'effect';
import { ZodError } from 'zod';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import {
  getCatalogLoadFailure,
  getCustomAgentScanIssues,
  refresh,
  resolveAgentForLaunch,
  settledCatalog,
} from '@agent/index';
import { requirePluginAgentLoads } from '@agent/index/pluginAgents';
import {
  logUserMessage,
  TraceEmitter,
  type AgentEvent,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { commitResumedActivation } from '@agent/storage/runLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getDisplayedInstruction } from '@agent/runtime/sessionDescription';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import { AgentError } from '@common/errors';
import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';
import {
  attachErrorPresentationClaimed,
  hasErrorPresentationClaimed,
} from '@common/errors/sdkError/errorMetadata';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import { type AttachedMemoryMiss, type RunId } from '@shared/schemas';
import {
  AgentCategory,
  INSTRUCTION_ACTION,
  RUN_OUTCOME,
} from '@shared/schemas';
import { selectModel } from '@shared/model/modelSelection';
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
  | 'opening'
  | 'initialUserMessageForTranscript'
>;

export interface AgentLaunchContext extends LaunchResolvedRunFacts {
  /**
   * The registry config of the launch model. The run's `AgentRun` service
   * binds it (or the model and route a resumed run's snapshot names); a
   * mid-run switch rebinds there.
   */
  readonly modelConfig: ModelConfig;
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
   * registered against it.
   */
  onRunResolved?: (runId: RunId) => void;
  /**
   * A second sink of the run's trace, beside the session's: it hears every
   * event the run emits, from the first (the instruction log, the root
   * stage, the launch warnings) until the run ends — the agent package's
   * live event stream, `stream.chunk` text included, which no row carries.
   */
  onTraceEvent?: (event: AgentEvent) => void;
  /** Session owning this run's coordination state. */
  session: SessionHandle;
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
    const selected = selectModel(modelName);
    if (selected) return selected.config;

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
 * transcript. See 2026-05-30-progress-grouping-refactor.md (R1).
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

/** A launch that misses names why: the catalog did not load, or the files the
 *  scan skipped (a custom agent it rejects is unlisted) and their reasons. */
const missNote = () => {
  const failure = getCatalogLoadFailure();
  const issues = getCustomAgentScanIssues();
  return (
    (failure === undefined
      ? ''
      : `. The agent catalog did not load: ${failure}`) +
    (issues.length === 0
      ? ''
      : `. Custom agent files that failed to load:${issues
          .map((issue) => `\n  ${issue.path}: ${issue.message}`)
          .join('')}`)
  );
};

export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (input: {
    config: AgentConfig;
    session: SessionHandle;
    enforceCategory?: boolean;
    suppressErrorNotification?: boolean;
  }) {
    const fullConfig = input.config;
    const interactions = input.session.interactions;
    // Single launch resolution rule (see resolveAgentForLaunch): pinned
    // (source, name), else the visible set validation used, else the full
    // category; never blind source-priority on a bare name. The catalog is settled
    // first (a saved edit inside the watcher's debounce is loaded now), and a
    // miss rescans once more.
    const resolve = resolveAgentForLaunch(
      input.session.roots,
      fullConfig.agentCategory,
      fullConfig.agent,
      fullConfig.agentSource,
    );
    yield* settledCatalog;
    const agentEntry =
      (yield* resolve) ??
      (yield* Effect.andThen(refresh(), resolve)) ??
      (yield* presentLaunchError(
        interactions,
        new AgentError(
          `Could not find agent: ${fullConfig.agent}${missNote()}`,
        ),
        'showAgentConfigBanner',
        {
          agentName: fullConfig.agent,
          category: fullConfig.agentCategory,
        },
      ));
    if (agentEntry.source === 'plugin')
      yield* requirePluginAgentLoads(
        agentEntry,
        yield* readInstalledPluginLoad(input.session.roots),
      );
    const { setting, prompt } = agentEntry;

    // Block category mismatch. Resolution is already category-scoped; this
    // catches what the registry's pre-merge category can't see: an agent that
    // `inherits` a parent of the other category, or an `agentSource` pinned
    // from a run record. Opt-in: chat roots, the CLI, subagents and resume.
    if (
      input.enforceCategory &&
      fullConfig.agentCategory !== setting.agentCategory
    ) {
      return yield* Effect.fail(
        new AgentError(
          `Agent '${fullConfig.agent}' is a ${setting.agentCategory} agent but was launched as ${fullConfig.agentCategory}.`,
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
    // `agent` stays as the caller spelled it (the resume-id contract). The
    // output list is normalized once, for the record and every reader: the
    // explicit list unless it names only inputs (an editing agent writes its
    // inputs back), else the agent's defaults.
    const explicit = fullConfig.outputFiles.filter(Boolean);
    const config: AgentConfig = {
      ...fullConfig,
      agentCategory: setting.agentCategory,
      agentSource: agentEntry.source,
      outputFiles: explicit.some(
        (file) => !fullConfig.inputFiles.includes(file),
      )
        ? explicit
        : (setting.defaultOutputFiles ?? []).filter(Boolean),
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

/**
 * Resolve the context of a run already admitted and created by registration.
 * A failure here is the launch's to end (`runWithLaunchGuard`, or a child
 * loop's tail). Interruptible: every acquisition settles atomically inside
 * its own `acquireRelease`, so an interruption lands between steps and the
 * scope's finalizers release whatever was acquired.
 */
export const buildAgentLaunchContext = Effect.fn('buildAgentLaunchContext')(
  function* (
    input: AgentLaunchInput,
  ): Effect.fn.Return<
    AgentLaunchContext,
    Error,
    Secrets | AppState | FileSystem.FileSystem | Scope.Scope
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
    // A resumed run's latest snapshot (one indexed read): whether its rows
    // hold its opening, and that opening's memory misses.
    const snapshot = input.resumed
      ? yield* session.ledger.latestSnapshot(runId)
      : null;
    const recorded = snapshot?.payload.state;
    // The run's model is bound from the stores the launch already has: the
    // session's own setting slots, so routing and the provider switches
    // answer for this run's workspace, and the process secret store.
    const stores: ModelOptionStores = {
      ...session.roots,
      secrets: yield* Secrets,
    };

    // The run's trace publishes into the session (and to the caller's tap);
    // the run's scope closes it when the run ends, and when a launch that
    // never became a run unwinds.
    const agentLogger = new TraceEmitter(
      (event) => session.publishRunEvent(runId, event),
      ...(input.onTraceEvent ? [input.onTraceEvent] : []),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => agentLogger.close()));

    // Registration committed creation, configuration and first activation; a
    // resume appends its activation here. It is durable before the run
    // resolves, so nothing drains here (lost facts are the terminal drain's),
    // and the append is uninterruptible: a stop lands before or after.
    if (input.resumed) {
      yield* Effect.uninterruptible(
        commitResumedActivation(session, runId, setting.agentCategory),
      );
    }

    input.onRunResolved?.(runId);

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
      buildTemplateInputs(
        config,
        setting,
        agentPath,
        modelConfig.provider === ModelProvider.ANTHROPIC,
        agentLogger,
        {
          // The session's own root, handed to prompt assembly as data: file
          // names, readable-file reads and CWD resolve against this project's
          // folder rather than whatever roots the calling fiber carries.
          workspacePath: session.roots.workspace,
          storageRoot: session.roots.storage,
          stageId,
        },
      );

    // A tool-use run whose rows hold its opening renders nothing again.
    const opening = yield* Effect.suspend(() => {
      if (setting.agentCategory === AgentCategory.ToolUse)
        return recorded === undefined ? buildVars() : Effect.succeed(null);

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
      ownApiKeyFallback: input.ownApiKeyFallback ?? false,
      // Frozen so nothing mutates it mid-run. A background script's run
      // ends when its script settles, launched or resumed: it has no later
      // turn for anything to wait for.
      toolPolicy: Object.freeze({
        ...input.toolPolicy,
        ...(config.agentCategory === AgentCategory.ToolUse &&
          config.backgroundScript != null && { stopAfterCycle: true }),
      }),
      stores,
      logger: agentLogger,
      parentStage,
      opening,
      attachedMemoryMisses:
        opening?.attachedMemoryMisses ?? recorded?.memoryMisses ?? [],
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
