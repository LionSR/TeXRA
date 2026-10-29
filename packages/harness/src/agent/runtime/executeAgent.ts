import * as path from 'node:path';

import { Deferred, Effect, Fiber, Layer } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { withLogChannel } from '@logger/effectLog';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  type CommitOrdinal,
  isTaskConfig,
  type RunId,
  type RequestEnsureProgressViewPayload,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';

import { withChildSpend } from '../storage/runRecords';
import {
  buildAgentLaunchContext,
  type PreparedAgentDefinition,
} from './AgentLaunchContext';
import { runWithLifecycle } from './AgentRunLifecycle';
import {
  generateSessionDescription,
  settleDescriptionOnExit,
} from './sessionDescription';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer } from './run/AgentRun';
import { runToolUse } from './loop/toolUse';
import type { AgentRunServices } from './runRegistry';
import type { RegisterRunOptions } from '../storage/runLifecycle';
import type { ChildRunTurns } from './childRunLoop';
import type { RunEndResult } from './RunEndResult';
import type { SessionHandle } from './SessionHandle';

const CHANNEL = 'executeAgent';

/** Toast payload shown when the progress view cannot be opened. */
type FallbackNotification = NonNullable<
  RequestEnsureProgressViewPayload['fallbackNotification']
>;

function buildFallbackNotification(config: AgentConfig): FallbackNotification {
  const primaryInput = config.inputFiles[0];
  const inputName = primaryInput
    ? path.basename(primaryInput)
    : 'selected input';
  const { outputFiles } = config;
  let outputInfo = '';
  if (outputFiles.length > 1) {
    outputInfo = `to ${outputFiles.length} files`;
  } else if (outputFiles[0]) {
    outputInfo = `to ${path.basename(outputFiles[0])}`;
  }
  return {
    agentName: config.agent,
    modelName: config.model,
    inputName,
    outputInfo,
  };
}

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
  readonly turns?: ChildRunTurns<RunEndResult>;
  /** Run-scoped tools added to the agent without mutating the default registry. */
  readonly tools?: readonly ITool[];
  /** Fires on meaningful progress: plan changes and tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** Fires once with the run's id as the run starts. */
  readonly onRun?: (runId: RunId) => Effect.Effect<void, Error>;
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
 * The run program, fresh or resumed: it opens the run's entry (a fresh run
 * registers with its opening, `options.registration`; a resume activates
 * the run its rows hold) and runs the loop under the run's lifecycle, with
 * the per-run layer: its `AgentRun`, the invoker, the session's run history
 * and rooted filesystems. Launches use `Runs.launch({ request, options })`
 * and resumes `resumeRun`; this runs on a fiber `RunRegistry.start` forked,
 * which provides the session's `Runs`.
 */
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
): Effect.Effect<RunEndResult, Error, AgentRunServices> {
  return Effect.gen(function* () {
    // Done once the run exists: its description is a row of it.
    const opened = yield* Deferred.make<void>();
    const launch = yield* buildAgentLaunchContext({
      definition,
      runId,
      registration: options.registration,
      parentRunId: options.parentRunId,
      onAdmitted: ({ commit }) =>
        Deferred.succeed(opened, undefined).pipe(
          Effect.andThen(options.onAdmitted?.(runId, commit) ?? Effect.void),
        ),
      session: options.session,
    });
    const { config, session } = launch;
    // A failed run arrives as a FAILED result carrying its structured
    // error, so there is nothing to unwrap here; a task's result carries
    // its children's spend.
    const resume = options.registration === undefined;
    const loop = runToolUse({ turns: options.turns, resume }).pipe(
      Effect.flatMap((ended) =>
        isTaskConfig(config)
          ? withChildSpend(session, ended)
          : Effect.succeed(ended),
      ),
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
    const lifecycle = {
      onRun: options.onRun,
      finishLastTurn: options.turns?.finishLastTurn,
    };
    if (resume) return yield* runWithLifecycle(launch, () => loop, lifecycle);

    // Start description generation concurrently with the run, and settle
    // it before the run ends (`settleDescriptionOnExit`), so the metadata
    // write cannot recreate a run deleted by another host.
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
          ),
        ),
      ),
    );
    // The backstop wait is `ensuring`, not a generator `finally`: the driver
    // skips a `finally` after a failed `yield*`, ending the run early.
    return yield* runWithLifecycle(
      launch,
      () =>
        Effect.gen(function* () {
          // The run directory is created by the first write into it.
          yield* Effect.logInfo(`Starting run (runId: ${runId})`).pipe(
            Effect.annotateLogs({
              data: {
                agent: config.agent,
                model: config.model,
                input: config.inputFiles[0] ?? '(none)',
                outputs: config.outputFiles.length,
              },
            }),
            withLogChannel(CHANNEL),
          );
          // Subagents don't need to force-open the progress board or show notifications;
          // the orchestrator's run is already visible.
          if (launch.entry.parent === null) {
            yield* session.interactions.emit(
              'requestEnsureProgressView',
              {
                fallbackNotification: buildFallbackNotification(config),
              },
              { replayWhenAttached: true },
            );
          }
          return yield* loop;
        }).pipe(settleDescriptionOnExit(sessionDescription, opened)),
      lifecycle,
    ).pipe(Effect.ensuring(Fiber.await(sessionDescription)));
  }).pipe(
    // The run's scope: the launch acquires the run trace into it and the
    // finalizer drops its subscribers once the run has ended. No mask: the
    // launch's acquisitions settle atomically (`acquireRelease`), so an
    // interruption lands between steps and this scope's finalizers run.
    Effect.scoped,
  );
}
