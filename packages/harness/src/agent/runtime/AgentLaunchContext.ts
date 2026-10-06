import * as path from 'node:path';

import { Cause, Effect, Exit, FileSystem, Scope } from 'effect';
import { ZodError } from 'zod';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { selectModel } from '@texra-ai/llm';
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
import { deriveResumability } from '@agent/storage/resumability';
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
import {
  INSTRUCTION_ACTION,
  isDocumentTaskConfig,
  RUN_OUTCOME,
  type AttachedMemoryMiss,
  type RunId,
} from '@shared/schemas';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { mcpServerOfToolName } from '@tools/mcp/mcpServer';
import { ToolRegistry } from '@tools/toolTable';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { declaredToolNames } from './agentToolResolution';
import type { AgentRunShape, ToolPolicy } from './run/AgentRun';
import type { SessionHandle } from './SessionHandle';
import type { SessionHostInteractions } from './HostInteractions';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

/**
 * The launch facts carried by {@link AgentRunShape}. The run narrows the
 * persona to its resolved tool list; every other fact reaches it unchanged.
 */
type LaunchResolvedRunFacts = Pick<
  AgentRunShape,
  | 'runId'
  | 'session'
  | 'workingDirectory'
  | 'delegationAgentScope'
  | 'config'
  | 'persona'
  | 'task'
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
    suppressErrorNotification?: boolean;
  }) {
    const fullConfig = input.config;
    const interactions = input.session.interactions;
    // Single launch resolution rule (see resolveAgentForLaunch): pinned
    // (source, name), else the visible set validation used, else the
    // catalog; never blind source-priority on a bare name. The catalog is settled
    // first (a saved edit inside the watcher's debounce is loaded now), and a
    // miss rescans once more.
    const resolve = resolveAgentForLaunch(
      input.session.roots,
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
        },
      ));
    if (agentEntry.source === 'plugin')
      yield* requirePluginAgentLoads(
        agentEntry,
        yield* readInstalledPluginLoad(input.session.roots),
      );
    const { persona, task } = agentEntry;

    // A declared tool no plugin registers, and no MCP server could, is a
    // configuration error (a typo, or a tool retired from the table): the
    // run is refused rather than started without it. A plugin switched off
    // still withholds its tools quietly at the step: that is the user's
    // switch, not the file's.
    const table = yield* ToolRegistry;
    const unknown = declaredToolNames(persona.tools).filter(
      (name) => !table.get(name) && mcpServerOfToolName(name) === undefined,
    );
    if (unknown.length > 0)
      return yield* Effect.fail(
        new AgentError(
          `Agent '${agentEntry.name}' declares ${unknown.length === 1 ? 'a tool' : 'tools'} TeXRA does not have: ${unknown.join(', ')}. Edit ${agentEntry.path} to remove or rename ${unknown.length === 1 ? 'it' : 'them'}; \`delegate_agent\` and \`delegate_workflow\` are now \`agent\`, and \`delegate_multi_agents\` is \`script\` with \`agent\`.`,
        ),
      );

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
      agentSource: agentEntry.source,
      outputFiles: explicit.some(
        (file) => !fullConfig.inputFiles.includes(file),
      )
        ? explicit
        : (task?.outputs ?? []).filter(Boolean),
    };
    return { config, persona, task, agentEntry, modelConfig };
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
    const { config, persona, task, agentEntry, modelConfig } = input.definition;
    // The run's working directory is decided here, once: absolute or absent.
    // Every tool call of the run carries it as `ToolContext.env.workingDirectory`
    // and trusts it rather than re-validating.
    const workingDirectory = yield* Effect.try({
      try: () => parseWorkingDirectory(config.workingDirectory),
      catch: ensureError,
    });

    // The session is resolved once at the boundary (buildAgentLaunchContext)
    // and carried in, so a delegated launch inherits the parent run's session
    // policy and a root launch gets the process default exactly once.
    const { session, runId } = input;
    // Whether a resumed run's rows hold its opening.
    const opened =
      input.resumed &&
      (yield* deriveResumability(runId, session)).kind === 'checkpoint';
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
      (event) => session.trace.publish(runId, event),
      ...(input.onTraceEvent ? [input.onTraceEvent] : []),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => agentLogger.close()));

    // Registration committed creation, configuration and first activation; a
    // resume appends its activation here. It is durable before the run
    // resolves, so nothing drains here (lost facts are the terminal drain's),
    // and the append is uninterruptible: a stop lands before or after.
    if (input.resumed) {
      yield* Effect.uninterruptible(commitResumedActivation(session, runId));
    }

    input.onRunResolved?.(runId);

    // Log the initial instruction as a user message so the run's tab
    // displays it inline with the stream log (no separate panel).
    const displayInstruction = getDisplayedInstruction(config);
    const initialInstruction =
      displayInstruction && !input.resumed ? displayInstruction : undefined;
    const supportsMediaInMessage =
      modelConfig.capabilities.supportsVision ||
      modelConfig.capabilities.supportsNativeAudio;
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
      // A scope that fails before the run's terminal row closes the stage
      // as failed; `end` is idempotent, so a published verdict stands.
      (stage, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.sync(() => stage.end(RUN_OUTCOME.FAILED)),
    );

    const agentPath = path.dirname(agentEntry.path);
    // Only a run opened on the recipe is a document task; its persona chats.
    const documentTask = isDocumentTaskConfig(config) ? task : null;
    const buildVars = (stageId?: string) =>
      buildTemplateInputs(
        config,
        documentTask,
        agentPath,
        modelConfig.provider === ModelProvider.ANTHROPIC,
        agentLogger,
        {
          // The session's own roots, handed to prompt assembly as data, so
          // file reads resolve in this project, not the calling fiber's.
          workspacePath: session.roots.workspace,
          storageRoot: session.roots.storage,
          stageId,
        },
      );

    // A conversation whose rows hold its opening renders nothing again; a
    // document task's tools render its templates from it at every call, a
    // resumed run's included.
    const opening = yield* Effect.suspend(() => {
      if (documentTask === null)
        return opened ? Effect.succeed(null) : buildVars();

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
      persona,
      task: documentTask,
      modelConfig,
      ownApiKeyFallback: input.ownApiKeyFallback ?? false,
      // Frozen so nothing mutates it mid-run. A script's run ends when its
      // script settles, launched or resumed: it has no later turn for
      // anything to wait for.
      toolPolicy: Object.freeze({
        ...input.toolPolicy,
        ...(config.script != null && { stopAfterCycle: true }),
      }),
      stores,
      logger: agentLogger,
      parentStage,
      opening,
      // A resumed run's are on its opening's `append`, which its loop
      // reports with its result.
      attachedMemoryMisses: opening?.attachedMemoryMisses ?? [],
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
