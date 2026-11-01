/**
 * The run program, fresh or resumed: what a run opens with (its entry
 * rows, its trace and stage, its opening), the services it runs under, the
 * description generated beside it, and the terminal that ends it
 * (`endRun`, `AgentRunLifecycle`). A launch reaches it through
 * `Runs.launch`, a resume through `resumeRun`, and a child's strategy
 * through `programs.executeAgent`; it runs on a fiber `RunRegistry.start`
 * forked, which provides the session's `Runs`.
 */
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';

import { ModelProvider } from '@texra-ai/llm';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { registrationRows } from '@agent/storage/runLifecycle';
import { logUserMessage, TraceEmitter, type AgentEvent } from '@agent/trace';
import { runEventDraft } from '@agent/trace/TraceEmitter';
import { AgentError } from '@common/errors/agentErrors';
import { withLogChannel } from '@logger/effectLog';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  type CommitOrdinal,
  isTaskConfig,
  RUN_OUTCOME,
  type RunId,
  type SubagentProgressUpdate,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { RegisterRunOptions } from '@shared/session/runFacts';
import { RunHistory } from '@shared/session/runHistory';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { parseWorkingDirectory } from '@tools/pathResolution';

import { endRun } from './AgentRunLifecycle';
import { runToolUse } from './loop/toolUse';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer, type RunLaunch } from './run/AgentRun';
import {
  generateSessionDescription,
  getDisplayedInstruction,
  settleDescriptionOnExit,
} from './sessionDescription';
import type { AgentRunServices } from './runRegistry';
import type { RunReport } from './runReport';
import type { ChildRunTurns } from './childRunLoop';
import type { PreparedAgentDefinition } from './AgentLaunchContext';
import type { SessionHandle } from './SessionHandle';

const CHANNEL = 'executeAgent';

/** Options for {@link executeAgent}. */
export interface ExecuteAgentOptions {
  /** Session owning this run's coordination state. */
  readonly session: SessionHandle;
  /** A fresh run's registration, which its opening batch commits: the run
   *  is born with its opening or not at all. Absent, the run is resumed. */
  readonly registration?: RegisterRunOptions;
  /** A resumed run's parent, as its rows hold it, read once by the resume;
   *  a fresh run's is its registration's. */
  readonly parentRunId?: RunId;
  /** The child-run policy: each turn's permit, each turn's settlement. */
  readonly turns?: ChildRunTurns<RunReport>;
  /** Run-scoped tools added to the agent without mutating the default registry. */
  readonly tools?: readonly ITool[];
  /** Fires on meaningful progress: plan changes and tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /**
   * The one admission hook, with the run admitted and the commit of the
   * batch that opened this activation (a fresh run's opening, a resume's
   * `run.activate`). The run runs it as that batch commits, which it holds:
   * keep it short.
   */
  readonly onAdmitted?: (
    runId: RunId,
    commit: CommitOrdinal,
  ) => Effect.Effect<void>;
}

/**
 * How a launch enters its run (`LaunchEntry`), its trace held until then:
 * the opening's batch carries it up to its first stream (the prompt line and
 * the run's stage commit with the opening), the rest is published once that
 * settled. One that never enters drops it. A run that exists is refused.
 * `opened` is done as the run enters: its description is a row of it.
 */
const enterRun = Effect.fn('enterRun')(function* (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
  opened: Deferred.Deferred<void>,
) {
  const { session } = options;
  const { config, stopAfterCycle } = definition;
  const registered =
    options.registration === undefined
      ? null
      : yield* registrationRows(session, runId, config, {
          ...options.registration,
          userFollowUpSupport: stopAfterCycle
            ? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED
            : USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
        });
  if (registered !== null && registered.start === null)
    return yield* new AgentError({
      message: `Run ${runId} already exists; resume it.`,
    });
  const registration = registered;
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
  // A fresh run's claim is its birth's: held for the run's scope from the
  // commit that created it, let go as the scope closes, after its end. A
  // claim the run cannot hold fails it, like any refused write.
  const scope = yield* Effect.scope;
  const entered: RunLaunch['entry']['entered'] = (state) =>
    Effect.sync(() => {
      for (const e of held?.slice(carried) ?? []) session.log.publish(runId, e);
      held = null;
    }).pipe(
      Effect.andThen(
        registration === null
          ? Effect.void
          : Scope.provide(session.log.hold(runId, { ends: true }), scope),
      ),
      Effect.andThen(Deferred.succeed(opened, undefined)),
      Effect.andThen(options.onAdmitted?.(runId, state.commit) ?? Effect.void),
    );
  const seed = options.registration?.seed ?? null;
  const parent =
    options.registration?.parentRunId ?? options.parentRunId ?? null;
  return { logger, entry: { parent, registration, seed, opening, entered } };
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
  opened: Deferred.Deferred<void>,
) {
  const { config, persona, modelConfig, stopAfterCycle } = definition;
  // The run's working directory is decided here, once: absolute or absent.
  // Every tool call of the run carries it as `ToolContext.env.workingDirectory`
  // and trusts it rather than re-validating.
  const workingDirectory = yield* Effect.fromResult(
    parseWorkingDirectory(config.workingDirectory),
  );

  // The session is resolved once at the boundary and carried in, so a
  // delegated launch inherits the parent run's session policy and a root
  // launch gets the process default exactly once.
  const { session } = options;
  const resumed = options.registration === undefined;
  const { logger: agentLogger, entry } = yield* enterRun(
    definition,
    runId,
    options,
    opened,
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
            workspacePath: session.roots.workspace,
            workingDirectory,
            storageRoot: session.roots.storage,
          },
        );

  const launch: RunLaunch = {
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
  return launch;
});

/**
 * The run program, fresh or resumed: it opens the run's entry (a fresh run
 * registers with its opening, `options.registration`; a resume activates
 * the run its rows hold) and runs the loop with the per-run layer: its
 * `AgentRun`, the invoker, the session's run history and rooted
 * filesystems. Every way the loop exits reaches the run's terminal
 * (`endRun`) exactly once, as the exit of the one masked region it runs
 * in: a started run is always finalized, and a failed one arrives as a
 * FAILED report carrying its failure. Launches use
 * `Runs.launch({ request, options })` and resumes `resumeRun`; this runs
 * on a fiber `RunRegistry.start` forked, which provides the session's
 * `Runs`.
 */
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
): Effect.Effect<RunReport, Error, AgentRunServices> {
  return Effect.gen(function* () {
    // Done once the run exists: its description is a row of it.
    const opened = yield* Deferred.make<void>();
    const launch = yield* buildAgentLaunchContext(
      definition,
      runId,
      options,
      opened,
    );
    const { config, session } = launch;
    const resume = options.registration === undefined;
    const loop = runToolUse({ turns: options.turns, resume }).pipe(
      Effect.provide(
        modelInvokerLayer().pipe(
          Layer.provideMerge(
            agentRunLayer(launch, {
              modelConfig: definition.modelConfig,
              tools: options.tools,
              callbacks: { onProgress: options.onProgress },
            }),
          ),
          Layer.provideMerge(Layer.succeed(RunHistory)(session.runHistory)),
          Layer.provideMerge(sessionFsLayer(session.roots)),
        ),
      ),
    );

    // Start description generation concurrently with the run, and settle
    // it before the run ends (`settleDescriptionOnExit`), so the metadata
    // write cannot recreate a run deleted by another host. A resumed run
    // whose process died before its description was written gets one now.
    // A child of the run's fiber, so the run's stop interrupts it, as it
    // interrupts the run.
    const sessionDescription = yield* Effect.forkChild(
      Deferred.await(opened).pipe(
        Effect.andThen(
          generateSessionDescription(
            runId,
            config,
            definition.agentEntry.description,
            session,
            resume,
          ),
        ),
      ),
    );
    const flow = resume
      ? loop
      : Effect.andThen(
          // The run directory is created by the first write into it.
          Effect.logInfo(`Starting run (runId: ${runId})`).pipe(
            Effect.annotateLogs({
              data: {
                agent: config.agent,
                model: config.model,
                input: config.inputFiles[0] ?? '(none)',
                outputs: config.outputFiles.length,
              },
            }),
            withLogChannel(CHANNEL),
          ),
          loop,
        );
    // The flow is an Effect: a fiber interruption reaches its provider work
    // directly, and its finalizers run before the resources above are
    // disposed. A fresh run is born with its opening, a resume activates
    // with its cell: both inside the flow, so the terminal ends either. The
    // run starts only inside the region whose exit is the terminal, so no
    // stop lands between the two: a started run is always finalized. The
    // host's stop is this run fiber's interruption (`RunRegistry.interrupt`);
    // the requests this run left open close with the fibers waiting on them
    // (`SessionRequests.ask`). The backstop wait is `ensuring`, not a
    // generator `finally`: the driver skips a `finally` after a failed
    // `yield*`, ending the run early.
    const report = yield* Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        Effect.exit(
          restore(
            flow.pipe(settleDescriptionOnExit(sessionDescription, opened)),
          ),
        ),
        (exit) => endRun(launch, exit, options.turns?.finishLastTurn),
      ),
    ).pipe(Effect.ensuring(Fiber.await(sessionDescription)));
    yield* Effect.logDebug(
      `Task completed with outcome: ${report.outcome}`,
    ).pipe(withLogChannel(CHANNEL));
    return report;
  }).pipe(
    // The run's scope: the launch acquires the run trace into it and the
    // finalizer drops its subscribers once the run has ended. No mask: the
    // launch's acquisitions settle atomically (`acquireRelease`), so an
    // interruption lands between steps and this scope's finalizers run.
    Effect.scoped,
  );
}
