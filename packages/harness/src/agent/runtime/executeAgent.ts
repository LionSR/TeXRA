/**
 * The run program, fresh or resumed, in two phases: the opening, which
 * commits in the caller's fiber (the run's entry rows, its trace held until
 * then, its first step) and answers the commit of that batch; and the run,
 * which the registry forks under the run's id (`RunRegistry.start`) and
 * which runs the loop with the per-run layer and ends through the one
 * terminal (`endRun`, `AgentRunLifecycle`). A root launch reaches it
 * through `rootRun` (`session.start`), a resume through `resumeRun`, and a
 * child's launch through `startChildRun` (`delegation/childLaunch.ts`).
 */
import {
  Clock,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
} from 'effect';

import { ModelProvider } from '@texra-ai/llm';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { registrationRows } from '@agent/storage/runLifecycle';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import { logUserMessage } from '@agent/trace/helpers';
import { runEventDraft } from '@agent/trace/TraceEmitter';
import { AgentError } from '@common/errors/agentErrors';
import { withLogChannel } from '@logger/effectLog';
import { SessionRoots } from '@platform/rootedFs';
import type { AgentEvent } from '@shared/session/agentEvent';
import {
  type CommitOrdinal,
  isTaskConfig,
  RUN_OUTCOME,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { RegisterRunOptions } from '@shared/session/runFacts';
import { SessionLog } from '@shared/session/runHistory';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { ProjectEnvironment } from '@utils/system/nodeWorkspace';

import { endRun } from './AgentRunLifecycle';
import { ChildRunBudget } from './childRunBudget';
import { openToolUse, runToolUse } from './loop/toolUse';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer, type RunLaunch } from './run/AgentRun';
import {
  generateSessionDescription,
  getDisplayedInstruction,
  RunLabels,
  settleDescriptionOnExit,
} from './sessionDescription';
import type { AgentRunServices } from './runRegistry';
import type { RunReport } from './runReport';
import type { PreparedAgentDefinition } from './AgentLaunchContext';

const CHANNEL = 'executeAgent';

/** Options for {@link executeAgent}. */
export interface ExecuteAgentOptions {
  /** A fresh run's registration, which its opening batch commits: the run
   *  is born with its opening or not at all. Absent, the run is resumed. */
  readonly registration?: RegisterRunOptions;
  /** A resumed run's parent, as its rows hold it, read once by the resume;
   *  a fresh run's is its registration's. */
  readonly parentRunId?: RunId;
  /** Run-scoped tools added to the agent without mutating the default registry. */
  readonly tools?: readonly ITool<Error, PluginToolServices>[];
  /** Fires on meaningful progress: plan changes and tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
}

/** A run whose opening committed: the commit of that batch, and the run
 *  itself, which the fiber that owns the run (the registry's) runs once. */
export interface PreparedRun {
  readonly activation: CommitOrdinal;
  readonly run: Effect.Effect<RunReport, Error, AgentRunServices>;
}

/**
 * How a launch enters its run (`LaunchEntry`), its trace held until then:
 * the opening's batch carries it up to its first stream (the prompt line and
 * the run's stage commit with the opening), the rest is published once that
 * settled. One that never enters drops it. A run that exists is refused.
 */
const enterRun = Effect.fn('enterRun')(function* (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
) {
  const log = yield* SessionLog;
  const { config, stopAfterCycle } = definition;
  const registered =
    options.registration === undefined
      ? null
      : yield* registrationRows(runId, config, {
          ...options.registration,
          // A child takes a message as its resume; a one-shot root none.
          takesFollowUps:
            !stopAfterCycle || options.registration.parentRunId !== undefined,
        });
  if (registered !== null && registered.start === null)
    return yield* new AgentError({
      message: `Run ${runId} already exists; resume it.`,
    });
  const registration = registered;
  let held: AgentEvent[] | null = [];
  const logger = new TraceEmitter((event) =>
    held === null ? log.publish(runId, event) : held.push(event),
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
  const entered: RunLaunch['entry']['entered'] = () =>
    Effect.sync(() => {
      for (const e of held?.slice(carried) ?? []) log.publish(runId, e);
      held = null;
    });
  const seed = options.registration?.seed ?? null;
  const parent =
    options.registration?.parentRunId ?? options.parentRunId ?? null;
  // Whether the parent's call awaits the child: a fresh run's
  // registration says; a resumed run's rows do.
  const awaited =
    options.registration !== undefined
      ? options.registration.parentCall?.awaited === true
      : ((yield* log.facts(runId))?.parent?.call?.awaited ?? false);
  return {
    logger,
    entry: { parent, awaited, registration, seed, opening, entered },
  };
});

/**
 * Resolve the context of a run admitted for launch: a fresh one, which its
 * opening registers, or a resume. Interruptible: every acquisition settles
 * atomically inside its own `acquireRelease`, so an interruption lands
 * between steps and the scope's finalizers release whatever was acquired.
 */
const buildAgentLaunchContext = Effect.fn('buildAgentLaunchContext')(function* (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
) {
  const { config, persona, modelConfig, stopAfterCycle } = definition;
  // The run's working directory is decided here, once: absolute or absent.
  // Every tool call of the run carries it as `ToolContext.env.workingDirectory`
  // and trusts it rather than re-validating.
  const workingDirectory = yield* Effect.fromResult(
    parseWorkingDirectory(config.workingDirectory),
  );

  // The session is the fiber's: a delegated launch runs on its parent's
  // session, and a root launch on the session it was started on.
  const roots = yield* SessionRoots;
  const resumed = options.registration === undefined;
  const { logger: agentLogger, entry } = yield* enterRun(
    definition,
    runId,
    options,
  );

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

  // The root "Run:" stage, its user instruction logged first so it has no
  // group and renders before the run group; a root never inherits a
  // parent run's stage.
  const parentStage = yield* Effect.acquireRelease(
    Effect.sync(() => {
      if (!initialMediaMayBeInserted && initialInstruction)
        logUserMessage(agentLogger, initialInstruction);
      return agentLogger.openStage(`Run: ${config.agent}`, { kind: 'run' });
    }),
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
            workspacePath: roots.workspace,
            workingDirectory,
            storageRoot: roots.storage,
          },
        );

  const launch: RunLaunch = {
    runId,
    startedAt: yield* Clock.currentTimeMillis,
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
  return launch;
});

/**
 * The provider API-key variables a launch brought, by variable name
 * (`StartOptions.apiKeys`), provided where the session starts or resumes
 * the run. A run reads them as it opens and carries them on its own fiber,
 * so a child it starts or resumes from its tool calls, and a leftover child
 * it resumes, opens with them; a sweep with no launch behind it has none.
 */
export const LaunchKeys = Context.Reference<Readonly<Record<string, string>>>(
  '@texra-ai/harness/LaunchKeys',
  { defaultValue: () => ({}) },
);

/**
 * `effect` in the run's environment with the launch's keys in it:
 * the project's `.env` first, then the keys, then this process's, for the
 * model binding (`ModelAccess`, which captures the config provider where
 * its layer is built) and for what a child process inherits
 * (`ProjectEnvironment`). Without keys, the environment as it is.
 */
const withApiKeys =
  (apiKeys: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    if (Object.keys(apiKeys).length === 0) return effect;
    return Effect.flatMap(ProjectEnvironment, (project) => {
      const variables = { ...apiKeys, ...project };
      return effect.pipe(
        Effect.provideService(ProjectEnvironment, variables),
        Effect.updateService(ConfigProvider.ConfigProvider, (ambient) =>
          ConfigProvider.orElse(
            ConfigProvider.fromEnvRecord(variables),
            ambient,
          ),
        ),
      );
    });
  };

/**
 * The run program, fresh or resumed. The opening runs here, in the
 * caller's fiber: it resolves the run's context and its per-run layer (its
 * `AgentRun` and the invoker, over the session's services the fiber
 * carries) and commits the run's entry (a fresh run registers with its
 * opening, `options.registration`; a resume activates the run its rows
 * hold), so a launch that fails before the run exists fails here with no
 * run behind it. The run it answers runs the loop over that opening, and
 * every way the loop exits reaches the run's terminal (`endRun`) exactly
 * once, as the exit of the one masked region it runs in: a started run is
 * always finalized, and a failed one arrives as a FAILED report carrying
 * its failure. Root launches use `rootRun` and resumes `resumeRun`; a
 * caller runs `run` only on the fiber `RunRegistry.start` forked for it.
 */
export const executeAgent = Effect.fn('executeAgent')(function* (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
): Effect.fn.Return<PreparedRun, Error, AgentRunServices> {
  // The run's resources: released as the run's fiber exits, or here when
  // the opening fails first.
  const scope = yield* Scope.make();
  const resume = options.registration === undefined;
  const keys = yield* LaunchKeys;
  const prepared = yield* Effect.gen(function* () {
    const launch = yield* buildAgentLaunchContext(definition, runId, options);
    // Said as the launch opens, before the model binds: a host's e2e reads
    // the service's log for it, and a launch refused for want of a key
    // still names the run it was asked for.
    if (!resume)
      yield* Effect.logInfo(`Starting run (runId: ${runId})`).pipe(
        Effect.annotateLogs({
          data: {
            agent: launch.config.agent,
            model: launch.config.model,
            input: launch.config.inputFiles[0] ?? '(none)',
            outputs: launch.config.outputFiles.length,
          },
        }),
        withLogChannel(CHANNEL),
      );
    const services = yield* Layer.build(
      modelInvokerLayer().pipe(
        Layer.provideMerge(
          agentRunLayer(launch, {
            modelConfig: definition.modelConfig,
            tools: options.tools,
            callbacks: { onProgress: options.onProgress },
          }),
        ),
      ),
    );
    const opening = yield* openToolUse({ resume }).pipe(
      Effect.provide(services),
    );
    return { launch, services, opening };
  }).pipe(
    withApiKeys(keys),
    Scope.provide(scope),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
    ),
  );
  const { launch, services, opening } = prepared;
  const { config } = launch;
  const run = Effect.gen(function* () {
    // A root run of a session that labels its runs gets its description
    // concurrently with the run, settled before the run ends
    // (`settleDescriptionOnExit`), so the metadata write cannot recreate a
    // run deleted by another host. A resumed run whose process died before
    // its description was written gets one now. A child of the run's
    // fiber, so the run's stop interrupts it, as it interrupts the run.
    const labelled = launch.entry.parent === null && (yield* RunLabels);
    const sessionDescription = yield* Effect.forkChild(
      labelled
        ? generateSessionDescription(
            runId,
            config,
            definition.agentEntry.description,
            resume,
          )
        : Effect.void,
    );
    const flow = runToolUse({ resume }, opening).pipe(Effect.provide(services));
    // The flow is an Effect: a fiber interruption reaches its provider work
    // directly, and its finalizers run before the resources above are
    // disposed. The run starts only inside the region whose exit is the
    // terminal, so no stop lands between the two: a started run is always
    // finalized. The host's stop is this run fiber's interruption
    // (`RunRegistry.stop`); the requests this run left open are cancelled in
    // its end's transaction (`cancelRequestRows`). The backstop wait is
    // `ensuring`, not a generator `finally`: the driver skips a `finally`
    // after a failed `yield*`, ending the run early.
    // A background child runs under the session's child-run budget; an
    // awaited one rides its parent's turn, a root takes none. The permit is
    // taken inside the region whose exit is the terminal: a stop that lands
    // while the run waits for one still ends it.
    const { parent, awaited } = launch.entry;
    const budgeted =
      parent === null || awaited
        ? flow
        : Effect.flatMap(ChildRunBudget, (budget) =>
            budget.withPermits(1)(flow),
          );
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        Effect.exit(
          restore(budgeted.pipe(settleDescriptionOnExit(sessionDescription))),
        ),
        (exit) => endRun(launch, exit),
      ),
    ).pipe(Effect.ensuring(Fiber.await(sessionDescription)));
  }).pipe(Effect.onExit((exit) => Scope.close(scope, exit)));
  return {
    activation: opening.activation,
    // The registry forks the run on the session's context, which holds no
    // launch's keys: the run carries its own.
    run: run.pipe(withApiKeys(keys), Effect.provideService(LaunchKeys, keys)),
  };
});
