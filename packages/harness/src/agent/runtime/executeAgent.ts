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
  Layer,
  Scope,
} from 'effect';

import { ModelProvider } from '@texra-ai/llm';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { registrationRows } from '@agent/storage/runLifecycle';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import { runEventDraft } from '@agent/trace/TraceEmitter';
import { AgentError } from '@common/errors/agentErrors';
import { withLogChannel } from '@logger/effectLog';
import { SessionRoots } from '@platform/rootedFs';
import type { AgentEvent } from '@shared/session/agentEvent';
import {
  type CommitOrdinal,
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
import { openToolUse, runToolUse } from './loop/runLoop';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer, type RunLaunch } from './run/AgentRun';
import { LabelsRootRuns, withSessionDescription } from './sessionDescription';
import type { AgentRunServices } from './runRegistry';
import type { PreparedAgentDefinition } from './AgentLaunchContext';

const CHANNEL = 'executeAgent';

/** Options for {@link executeAgent}. */
export interface ExecuteAgentOptions {
  /** A fresh run's registration, which its opening batch commits: the run
   *  is born with its opening or not at all. Absent, the run is resumed. */
  readonly registration?: RegisterRunOptions;
  /** A resumed run's parent, as its rows hold it, read once by the resume;
   *  a fresh run's is its registration's. */
  readonly parentId?: RunId;
  /** Run-scoped tools added to the agent without mutating the default registry. */
  readonly tools?: readonly ITool<Error, PluginToolServices>[];
  /** Fires on meaningful progress: plan changes and tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** The caller asks a root to end after one model/tool cycle instead of
   *  waiting for input (a launch that is not interactive). A child, a
   *  script and a root launched to run once end after it whatever this
   *  says. */
  readonly stopAfterCycle?: boolean;
}

/** A run whose opening committed: the commit of that batch, and the run
 *  itself, which the fiber that owns the run (the registry's) runs once. */
export interface PreparedRun {
  readonly activation: CommitOrdinal;
  readonly run: Effect.Effect<void, Error, AgentRunServices>;
}

/**
 * How a launch enters its run (`LaunchEntry`), its trace held until then:
 * the opening's batch carries it up to its first stream (the prompt line and
 * the run's stage commit with the opening), the rest is published once that
 * finished. One that never enters drops it. A run that exists is refused.
 */
const enterRun = Effect.fn('enterRun')(function* (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
) {
  const log = yield* SessionLog;
  const { config } = definition;
  const parent = options.registration?.parentId ?? options.parentId ?? null;
  // A resumed run's facts, read once: whether its parent's call awaits it,
  // and whether its launch let it take input.
  const facts =
    options.registration === undefined ? yield* log.facts(runId) : null;
  // Whether the parent's call awaits the child: a fresh run's
  // registration says; a resumed run's rows do.
  const awaited =
    options.registration !== undefined
      ? options.registration.parentCall?.awaited === true
      : (facts?.start?.parent?.call?.awaited ?? false);
  // Whether the run ends after one cycle, decided once: every child does
  // (a message to it is a resume), a script's run (its call is its only
  // turn), a root its caller asks to, and a root launched to run once,
  // which no message may reach, whoever resumes it.
  const stopAfterCycle =
    parent !== null ||
    config.script != null ||
    options.stopAfterCycle === true ||
    facts?.start?.takesFollowUps === false;
  const registered =
    options.registration === undefined
      ? null
      : yield* registrationRows(runId, config, {
          ...options.registration,
          // A child takes a message as its resume; a one-shot root none.
          takesFollowUps: !stopAfterCycle || parent !== null,
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
  const enter: RunLaunch['entry']['enter'] = (commit) => {
    // How many held events the batch took, counted as its job reads them.
    let carried = 0;
    const alongside = Effect.sync((): readonly UnfoldedDraft[] => {
      const events = held ?? [];
      carried = events.findIndex((e) => e.type.startsWith('stream.'));
      if (carried < 0) carried = events.length;
      return events
        .slice(0, carried)
        .flatMap((e) => runEventDraft(runId, e) ?? []);
    });
    return commit(alongside).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const e of held?.slice(carried) ?? []) log.publish(runId, e);
          held = null;
        }),
      ),
      Effect.uninterruptible,
    );
  };
  const seed = options.registration?.seed ?? null;
  return {
    logger,
    stopAfterCycle,
    entry: { parent, awaited, registration, seed, enter },
  };
});

/**
 * Resolve the context of a run accepted for launch: a fresh one, which its
 * opening registers, or a resume. Interruptible: every acquisition finishes
 * atomically inside its own `acquireRelease`, so an interruption lands
 * between steps and the scope's finalizers release whatever was acquired.
 */
const buildAgentLaunchContext = Effect.fn('buildAgentLaunchContext')(function* (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
) {
  const { config, persona, modelConfig } = definition;
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
  const {
    logger: agentLogger,
    stopAfterCycle,
    entry,
  } = yield* enterRun(definition, runId, options);

  // A resume renders nothing again: the run's rows hold its opening.
  const opening = resumed
    ? null
    : yield* buildTemplateInputs(
        config,
        modelConfig.provider === ModelProvider.ANTHROPIC,
        {
          // The session's own roots, handed to prompt assembly as data, so
          // the working directory and memories resolve in this project, not
          // the calling fiber's.
          workspaceRoot: roots.workspace,
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
    opening,
    entry,
  };
  return launch;
});

/**
 * The provider API-key variables a launch brought, by variable name
 * (`StartInput.apiKeys`), provided where the session starts or resumes
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
 * once, as the exit of the one masked region it runs in. Callers read the
 * outcome and output from its committed end. Root launches use `rootRun`
 * and resumes `resumeRun`; a caller runs `run` only on the fiber
 * `RunRegistry.start` forked for it.
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
    // beside the run (`withSessionDescription`); a resumed run whose process
    // died before its description was written gets one now.
    const labelled = launch.entry.parent === null && (yield* LabelsRootRuns);
    const flow = runToolUse({ resume }, opening).pipe(Effect.provide(services));
    // The flow is an Effect: a fiber interruption reaches its provider work
    // directly, and its finalizers run before the resources above are
    // disposed. The run starts only inside the region whose exit is the
    // terminal, so no stop lands between the two: a started run is always
    // finalized. The host's stop is this run fiber's interruption
    // (`RunRegistry.stop`); the requests this run left open are cancelled in
    // its end's transaction (`cancelRequestRows`).
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
    // A labelled run is a root, so its flow takes no budget permit.
    const described = labelled
      ? budgeted.pipe(
          withSessionDescription(
            runId,
            config,
            definition.agentEntry.description,
            resume,
          ),
        )
      : budgeted;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Effect.exit(restore(described)), (exit) =>
        endRun(launch, exit),
      ),
    );
  }).pipe(Effect.onExit((exit) => Scope.close(scope, exit)));
  return {
    activation: opening.activation,
    // The registry forks the run on the session's context, which holds no
    // launch's keys: the run carries its own.
    run: run.pipe(withApiKeys(keys), Effect.provideService(LaunchKeys, keys)),
  };
});
