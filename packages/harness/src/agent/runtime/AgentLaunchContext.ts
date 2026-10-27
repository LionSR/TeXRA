import { Cause, Effect, Exit, FileSystem, Schema, Scope } from 'effect';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { selectModel } from '@texra-ai/llm';
import { AgentCatalog } from '@agent/index/agentCatalog';
import { agentEntryOf } from '@agent/index/agentYamlScanner';
import { requirePluginAgentLoads } from '@agent/index/pluginAgents';
import {
  logUserMessage,
  TraceEmitter,
  type AgentEvent,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { runEventDraft } from '@agent/trace/TraceEmitter';
import {
  registrationRows,
  type RegisterRunOptions,
} from '@agent/storage/runLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getDisplayedInstruction } from '@agent/runtime/sessionDescription';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import { AgentError } from '@common/errors/agentErrors';
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
  isTaskConfig,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { mcpServerOfToolName } from '@tools/mcp/mcpServer';
import { ToolRegistry } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  | 'logger'
  | 'parentStage'
  | 'toolPolicy'
  | 'opening'
  | 'entry'
> &
  Pick<AgentRunShape['toolInputs'], 'stores'>;

export interface AgentLaunchContext extends LaunchResolvedRunFacts {
  /** The launch model's registry config, which `AgentRun` binds (or a
   *  resumed run's snapshot's); a mid-run switch rebinds there. */
  readonly modelConfig: ModelConfig;
  /** Description from the exact registry entry selected for this launch. */
  readonly resolvedAgentDescription?: string;
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
  /** A fresh run's admission, once its opening committed: it never waits. */
  onAdmitted?: (runId: RunId) => Effect.Effect<void>;
  /** Session owning this run's coordination state. */
  session: SessionHandle;
  /** Immutable per-run tool policy carried on the launch context for cycle flows. */
  toolPolicy?: ToolPolicy;
}

/**
 * Present a launch error through its targeted host notice (replayed if no
 * host is attached) and fail with it claimed, so no generic toast repeats
 * it; a host that throws on the notice shows that toast instead.
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
      new AgentError({ message: `Model ${modelName} is not registered` }),
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
 * run's stage.
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
  function* (input: {
    config: AgentConfig;
    session: SessionHandle;
    suppressErrorNotification?: boolean;
  }) {
    const fullConfig = input.config;
    const interactions = input.session.interactions;
    // A persona the config carries (its schema admitted it) is the agent;
    // a named one resolves over a settled catalog, and a miss says why.
    const agentEntry =
      fullConfig.persona != null
        ? agentEntryOf(fullConfig.persona, { source: 'inline', path: '' })
        : yield* (yield* AgentCatalog)
            .forLaunch(
              input.session.roots,
              fullConfig.agent,
              fullConfig.agentSource,
            )
            .pipe(
              Effect.catchTag('AgentNotFound', (missed) =>
                presentLaunchError(
                  interactions,
                  new AgentError({ message: missed.message }),
                  'showAgentConfigBanner',
                  { agentName: fullConfig.agent },
                ),
              ),
            );
    if (agentEntry.source === 'plugin')
      yield* requirePluginAgentLoads(
        agentEntry,
        yield* readInstalledPluginLoad(input.session.roots),
      );
    const { persona } = agentEntry;

    // A declared tool nothing could serve is a configuration error: the run
    // is refused (a plugin switched off withholds its tools at the step).
    const table = yield* ToolRegistry;
    const unknown = declaredToolNames(persona.tools).filter(
      (name) => !table.get(name) && mcpServerOfToolName(name) === undefined,
    );
    if (unknown.length > 0)
      return yield* new AgentError({
        message: `Agent '${agentEntry.name}' declares ${unknown.length === 1 ? 'a tool' : 'tools'} this build does not have: ${unknown.join(', ')}. Edit ${agentEntry.path || 'the persona'} to remove or rename ${unknown.length === 1 ? 'it' : 'them'}; \`delegate_agent\` and \`delegate_workflow\` are now \`agent\`, and \`delegate_multi_agents\` is \`script\` with \`agent\`.`,
      });

    // Validated before registration, so a typo'd model name registers no
    // FAILED execution and surfaces only its targeted instruction.
    const modelConfig = yield* validateModelExists(
      fullConfig.model,
      interactions,
    );

    // The resolved source is stamped (`agent` stays as spelled); a task's
    // outputs are its plugin's, stamped by the launch that built it.
    const config: AgentConfig = {
      ...fullConfig,
      agentSource: agentEntry.source,
    };
    return { config, persona, agentEntry, modelConfig };
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
            error instanceof Schema.SchemaError ||
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
 * How a launch enters its run (`LaunchEntry`), its trace held until then:
 * the opening's batch carries it up to its first stream (the prompt line and
 * the run's stage commit with the opening), the rest is published once that
 * settled. One that never enters drops it. A run that exists is refused.
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
    return yield* new AgentError({
      message: `Run ${runId} already exists; resume it.`,
    });
  let held: AgentEvent[] | null = [];
  const logger = new TraceEmitter(
    (event) =>
      held === null ? session.log.publish(runId, event) : held.push(event),
    // The run's trace port: every caller reading its events, joiners too.
    (event) => session.trace.tap(runId, event),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => logger.close()));
  let carried = 0;
  const opening = Effect.sync((): readonly UnfoldedDraft[] => {
    const events = held ?? [];
    carried = events.findIndex((e) => e.type.startsWith('stream.'));
    if (carried < 0) carried = events.length;
    return events
      .slice(0, carried)
      .flatMap((e) => runEventDraft(runId, e) ?? []);
  });
  const entered = Effect.sync(() => {
    for (const e of (held ?? []).slice(carried)) session.log.publish(runId, e);
    held = null;
  }).pipe(Effect.andThen(input.onAdmitted?.(runId) ?? Effect.void));
  const seed = input.registration?.seed ?? null;
  return { logger, entry: { registration, seed, opening, entered } };
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
    const { config, persona, agentEntry, modelConfig } = input.definition;
    // The run's working directory is decided here, once: absolute or absent.
    // Every tool call of the run carries it as `ToolContext.env.workingDirectory`
    // and trusts it rather than re-validating.
    const workingDirectory = yield* Effect.fromResult(
      parseWorkingDirectory(config.workingDirectory),
    );

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

    // A task's tools render their templates from this opening at every
    // call, so it is built on resume too; a conversation's rows hold its own.
    const opening =
      resumed && !isTaskConfig(config)
        ? null
        : yield* buildTemplateInputs(
            config,
            modelConfig.provider === ModelProvider.ANTHROPIC,
            agentLogger,
            {
              // The session's own roots, handed to prompt assembly as data,
              // so file reads resolve in this project, not the calling
              // fiber's.
              workspacePath: session.roots.workspace,
              storageRoot: session.roots.storage,
            },
          );

    const context: AgentLaunchContext = {
      runId,
      session,
      workingDirectory,
      delegationAgentScope: config.delegationAgentScope,
      config,
      resolvedAgentDescription: agentEntry.description,
      persona,
      modelConfig,
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
    };
    // Frozen at the run's one real construction site: a run's identity, its
    // owning session, and the rest of what the launch resolved must not change
    // under the loop that reads them, and `readonly` alone stops only the
    // callers that kept their types.
    return Object.freeze(context);
  },
);
