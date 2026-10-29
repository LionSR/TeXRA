import { Cause, Effect, Exit, FileSystem, Schema, Scope } from 'effect';

import { ModelProvider, selectModel } from '@texra-ai/llm';
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
import { AppState } from '@platform/interfaces';
import {
  INSTRUCTION_ACTION,
  isTaskConfig,
  RUN_OUTCOME,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { mcpServerOfToolName } from '@shared/tools/toolDisplayName';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { ToolRegistry } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { declaredToolNames } from './agentToolResolution';
import type { AgentRunShape, RunLaunch } from './run/AgentRun';
import type { SessionHandle } from './SessionHandle';
import type { SessionHostInteractions } from './HostInteractions';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

interface AgentLaunchInput {
  definition: PreparedAgentDefinition;
  runId: RunId;
  /** A fresh run's registration, which its opening batch commits; absent,
   *  a resume: its cell activates the run, which logs no instruction again. */
  registration?: RegisterRunOptions;
  /** A resume's parent, its rows' edge: what this activation runs under. */
  parentRunId?: RunId;
  /** The run's admission, once its activation's batch committed: no wait. */
  onAdmitted?: AgentRunShape['entry']['entered'];
  /** Session owning this run's coordination state. */
  session: SessionHandle;
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
  if (instruction) logUserMessage(agentLogger, instruction);
  return agentLogger.openStage(label, { kind: 'run' });
}

export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (input: {
    config: AgentConfig;
    session: SessionHandle;
    suppressErrorNotification?: boolean;
    /** The launch ends the run after one cycle (an awaited child). */
    stopAfterCycle?: boolean;
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
    // Whether the run takes follow-ups, decided once: a run whose launch
    // ends it after one cycle, or whose script is its only turn, does not,
    // and registers as such.
    const stopAfterCycle =
      input.stopAfterCycle === true || config.script != null;
    return { config, persona, agentEntry, modelConfig, stopAfterCycle };
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
const enterRun = Effect.fn('enterRun')(function* (input: AgentLaunchInput) {
  const { session, runId } = input;
  const { config, stopAfterCycle } = input.definition;
  const registered =
    input.registration === undefined
      ? null
      : yield* registrationRows(session, runId, config, {
          ...input.registration,
          userFollowUpSupport: stopAfterCycle
            ? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED
            : USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
        });
  if (registered !== null && !registered.born)
    return yield* new AgentError({
      message: `Run ${runId} already exists; resume it.`,
    });
  const registration = registered?.rows ?? null;
  let held: AgentEvent[] | null = [];
  const logger = new TraceEmitter((event) =>
    held === null ? session.log.publish(runId, event) : held.push(event),
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
  const entered: AgentRunShape['entry']['entered'] = (state) =>
    Effect.sync(() => {
      for (const e of held?.slice(carried) ?? []) session.log.publish(runId, e);
      held = null;
    }).pipe(Effect.andThen(input.onAdmitted?.(state) ?? Effect.void));
  const seed = input.registration?.seed ?? null;
  const parent = input.registration?.parentRunId ?? input.parentRunId ?? null;
  return { logger, entry: { parent, registration, seed, opening, entered } };
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
    RunLaunch,
    Error,
    AppState | FileSystem.FileSystem | Scope.Scope
  > {
    const { config, persona, modelConfig, stopAfterCycle } = input.definition;
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
    const { logger: agentLogger, entry } = yield* enterRun(input);

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

    return {
      runId,
      session,
      workingDirectory,
      config,
      persona,
      toolPolicy: { stopAfterCycle },
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
  },
);
