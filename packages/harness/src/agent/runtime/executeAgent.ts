/**
 * The run program, fresh or resumed: what a run opens with (its entry
 * rows, its trace and stage, its opening), the services it runs under, the
 * description generated beside it, and the terminal that ends it
 * (`endRun`, `AgentRunLifecycle`). A root launch reaches it through
 * `rootRun` (`session.start`), a resume through `resumeRun`, and a child's
 * strategy through `programs.executeAgent`; it runs on a fiber
 * `RunRegistry.start` forked, whose context carries the session's services.
 */
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';

import { ModelProvider } from '@texra-ai/llm';
import { buildTemplateInputs } from '@agent/prompt/templateInputs';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { registrationRows } from '@agent/storage/runLifecycle';
import { logUserMessage, TraceEmitter } from '@agent/trace';
import { runEventDraft } from '@agent/trace/TraceEmitter';
import { AgentError } from '@common/errors/agentErrors';
import { withLogChannel } from '@logger/effectLog';
import { SessionRoots } from '@platform/rootedFs';
import type { AgentEvent } from '@shared/session/agentEvent';
import {
  isTaskConfig,
  RUN_OUTCOME,
  type RunId,
  type SubagentProgressUpdate,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { RegisterRunOptions } from '@shared/session/runFacts';
import { SessionLog } from '@shared/session/runHistory';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { parseWorkingDirectory } from '@tools/pathResolution';

import { endRun } from './AgentRunLifecycle';
import { runToolUse } from './loop/toolUse';
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
import type { ChildRunTurns } from './childRunLoop';
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
  /** The child-run policy: each turn's permit, each turn's settlement. */
  readonly turns?: ChildRunTurns<RunReport, AgentRunServices>;
  /** Run-scoped tools added to the agent without mutating the default registry. */
  readonly tools?: readonly ITool<Error, PluginToolServices>[];
  /** Fires on meaningful progress: plan changes and tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
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
  const log = yield* SessionLog;
  const { config, stopAfterCycle } = definition;
  const registered =
    options.registration === undefined
      ? null
      : yield* registrationRows(runId, config, {
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
  // A fresh run's claim is its birth's: held for the run's scope from the
  // commit that created it, let go as the scope closes, after its end. A
  // claim the run cannot hold fails it, like any refused write.
  const scope = yield* Effect.scope;
  const entered: RunLaunch['entry']['entered'] = () =>
    Effect.sync(() => {
      for (const e of held?.slice(carried) ?? []) log.publish(runId, e);
      held = null;
    }).pipe(
      Effect.andThen(
        registration === null
          ? Effect.void
          : Scope.provide(log.hold(runId, { ends: true }), scope),
      ),
      Effect.andThen(Deferred.succeed(opened, undefined)),
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

  // The session is the fiber's: a delegated launch runs on its parent's
  // session, and a root launch on the session it was started on.
  const roots = yield* SessionRoots;
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
            workspacePath: roots.workspace,
            workingDirectory,
            storageRoot: roots.storage,
          },
        );

  const launch: RunLaunch = {
    runId,
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
 * `AgentRun` and the invoker, over the session's services its fiber
 * carries. Every way the loop exits reaches the run's terminal
 * (`endRun`) exactly once, as the exit of the one masked region it runs
 * in: a started run is always finalized, and a failed one arrives as a
 * FAILED report carrying its failure. Root launches use `rootRun` and
 * resumes `resumeRun`; this runs on a fiber `RunRegistry.start` forked,
 * whose context carries the session's services.
 */
export const executeAgent: (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
) => Effect.Effect<RunReport, Error, AgentRunServices> = Effect.fn(
  'executeAgent',
)(function* (
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
) {
  // Done once the run exists: its description is a row of it.
  const opened = yield* Deferred.make<void>();
  const launch = yield* buildAgentLaunchContext(
    definition,
    runId,
    options,
    opened,
  );
  const { config } = launch;
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
      ),
    ),
  );

  // A root run of a session that labels its runs gets its description
  // concurrently with the run, settled before the run ends
  // (`settleDescriptionOnExit`), so the metadata write cannot recreate a
  // run deleted by another host. A resumed run whose process died before
  // its description was written gets one now. A child of the run's fiber,
  // so the run's stop interrupts it, as it interrupts the run.
  const labelled = launch.entry.parent === null && (yield* RunLabels);
  const sessionDescription = yield* Effect.forkChild(
    labelled
      ? Deferred.await(opened).pipe(
          Effect.andThen(
            generateSessionDescription(
              runId,
              config,
              definition.agentEntry.description,
              resume,
            ),
          ),
        )
      : Effect.void,
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
        restore(flow.pipe(settleDescriptionOnExit(sessionDescription, opened))),
      ),
      (exit) => endRun(launch, exit, options.turns?.finishLastTurn),
    ),
  ).pipe(Effect.ensuring(Fiber.await(sessionDescription)));
  yield* Effect.logDebug(`Task completed with outcome: ${report.outcome}`).pipe(
    withLogChannel(CHANNEL),
  );
  return report;
}, Effect.scoped);
