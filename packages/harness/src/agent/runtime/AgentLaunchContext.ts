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
} from '@agent/index/agentRegistry';
import { agentEntryOf } from '@agent/index/agentYamlScanner';
import { requirePluginAgentLoads } from '@agent/index/pluginAgents';
import {
  logUserMessage,
  TraceEmitter,
  type AgentEvent,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import {
  registrationRows,
  type RegisterRunOptions,
} from '@agent/storage/runLifecycle';
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
  | 'entry'
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
   * A fresh run's registration, which its opening batch commits; absent,
   * the launch resumes a run an earlier activation started: its cell
   * activates it, and the initial instruction is not logged again.
   */
  registration?: RegisterRunOptions;
  /**
   * Fires once the run exists for every fold (a fresh run's opening has
   * committed), so a host may select it (its own surface state, never a
   * fact) and approval ancestry may be registered against it.
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
 * host is attached) and fail with it claimed, so no generic toast repeats
 * it; a host that throws on the notice shows that toast instead (#10398).
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
 * Create a root "Run:" stage, logging a user instruction first so it has no
 * group and renders before the run group; a root never inherits a parent
 * run's stage (2026-05-30-progress-grouping-refactor.md, R1).
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
    // One resolution rule (resolveAgentForLaunch), over a settled catalog;
    // a miss rescans.
    const resolve = resolveAgentForLaunch(
      input.session.roots,
      fullConfig.agent,
      fullConfig.agentSource,
    );
    // A persona the config carries (its schema admitted it) is the agent.
    const agentEntry =
      fullConfig.persona != null
        ? agentEntryOf(fullConfig.persona, { source: 'inline', path: '' })
        : ((yield* Effect.andThen(settledCatalog, resolve)) ??
          (yield* Effect.andThen(refresh(), resolve)) ??
          (yield* presentLaunchError(
            interactions,
            new AgentError(
              `Could not find agent: ${fullConfig.agent}${missNote()}`,
            ),
            'showAgentConfigBanner',
            { agentName: fullConfig.agent },
          )));
    if (agentEntry.source === 'plugin')
      yield* requirePluginAgentLoads(
        agentEntry,
        yield* readInstalledPluginLoad(input.session.roots),
      );
    const { persona, task } = agentEntry;

    // A declared tool nothing could serve is a configuration error: the run
    // is refused (a plugin switched off withholds its tools at the step).
    const table = yield* ToolRegistry;
    const unknown = declaredToolNames(persona.tools).filter(
      (name) => !table.get(name) && mcpServerOfToolName(name) === undefined,
    );
    if (unknown.length > 0)
      return yield* Effect.fail(
        new AgentError(
          `Agent '${agentEntry.name}' declares ${unknown.length === 1 ? 'a tool' : 'tools'} TeXRA does not have: ${unknown.join(', ')}. Edit ${agentEntry.path || 'the persona'} to remove or rename ${unknown.length === 1 ? 'it' : 'them'}; \`delegate_agent\` and \`delegate_workflow\` are now \`agent\`, and \`delegate_multi_agents\` is \`script\` with \`agent\`.`,
        ),
      );

    // Validated before registration, so a typo'd model name registers no
    // FAILED execution and surfaces only its targeted instruction.
    const modelConfig = yield* validateModelExists(
      fullConfig.model,
      interactions,
    );

    // The resolved source is stamped (`agent` stays as spelled); the outputs
    // are the explicit list unless it names only inputs, else the defaults.
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
          attachErrorPresentationClaimed(error);
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
 * How a launch enters its run (`LaunchEntry`), and the run's trace, held
 * until then and published in order once the entering batch commits (a
 * launch that never enters drops it: its failure is the launch's). A fresh
 * launch onto a run that exists is refused.
 */
const enterRun = Effect.fn('enterRun')(function* (
  input: AgentLaunchInput,
  config: AgentConfig,
) {
  const { session, runId } = input;
  const registration =
    input.registration === undefined
      ? null
      : yield* registrationRows(session, runId, config, input.registration);
  if (registration !== null && registration[0]?.type !== 'run.start')
    return yield* Effect.fail(
      new AgentError(`Run ${runId} already exists; resume it.`),
    );
  let held: AgentEvent[] | null = [];
  const logger = new TraceEmitter(
    (event) =>
      held === null ? session.log.publish(runId, event) : held.push(event),
    ...(input.onTraceEvent ? [input.onTraceEvent] : []),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => logger.close()));
  const entered = Effect.sync(() => {
    for (const event of held ?? []) session.log.publish(runId, event);
    held = null;
    input.onRunResolved?.(runId);
  });
  return { logger, entry: { registration, entered } };
});

/**
 * Resolve the context of a run admitted for launch: a fresh one, which its
 * opening registers, or a resume. Interruptible: every acquisition settles atomically inside
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
    const resumed = input.registration === undefined;
    const { logger: agentLogger, entry } = yield* enterRun(input, config);
    // The run's model is bound from the stores the launch already has: the
    // session's own setting slots, so routing and the provider switches
    // answer for this run's workspace, and the process secret store.
    const stores: ModelOptionStores = {
      ...session.roots,
      secrets: yield* Secrets,
    };

    // Log the initial instruction as a user message so the run's tab
    // displays it inline with the stream log (no separate panel).
    const displayInstruction = getDisplayedInstruction(config);
    const initialInstruction =
      displayInstruction && !resumed ? displayInstruction : undefined;
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

    // A resumed conversation's rows hold its opening, which renders nothing
    // again; a document task's tools render its templates from it at every
    // call, a resumed run's included.
    const opening = yield* Effect.suspend(() => {
      if (documentTask === null)
        return resumed ? Effect.succeed(null) : buildVars();

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
      entry: {
        ...entry,
        initialUserMessage: initialMediaMayBeInserted
          ? initialInstruction
          : undefined,
      },
      // A resumed run's are on its opening's `append`, which its loop
      // reports with its result.
      attachedMemoryMisses: opening?.attachedMemoryMisses ?? [],
    };
    // Frozen at the run's one real construction site: a run's identity, its
    // owning session, and the rest of what the launch resolved must not change
    // under the loop that reads them, and `readonly` alone stops only the
    // callers that kept their types.
    return Object.freeze(context);
  },
);
