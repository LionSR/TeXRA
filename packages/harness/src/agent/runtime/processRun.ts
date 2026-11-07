/**
 * A process child: a run whose one turn an external process is (a
 * background shell, a coding agent's CLI). The tool launching it supplies
 * the turn ({@link ProcessChildLaunch}); the harness registers the run
 * under the launching call, forks the turn under the run's id on the
 * session's registry, and ends the run with what the turn reports: its
 * delivery (`run.report`, queued on the parent's input by the end's
 * transaction), the process's exit (`process.exit`), and a failure the
 * process reported. The process's output goes to the run's trace as it
 * arrives (`AgentTrace.output`). A stop interrupts the turn, and a stopped
 * process run delivers nothing: its interruption is the fact. A process
 * run is never resumed: a later turn of the same thread is a new run, and
 * a message to one is refused (`takesFollowUps: false`).
 */
import { Effect, Exit } from 'effect';

import { ToolContext } from '@agent/core/tools/ToolTypes';
import type { PlatformServices } from '@platform/processRuntime';
import type { RunRecord } from '@agent/core/definition/RunRecord';
import { endVerdict } from '@agent/runtime/AgentRunLifecycle';
import { childRunDescription } from '@agent/runtime/delegation/childRun';
import {
  registryOf,
  Runs,
  type AgentRunServices,
} from '@agent/runtime/runRegistry';
import { endRunRows, registerRun } from '@agent/storage/runLifecycle';
import type { AgentTrace } from '@agent/trace/AgentTrace';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import {
  generateRunId,
  qualifyAggregateId,
  RUN_OUTCOME,
  type ProcessExit,
  type RunEnd,
  type RunId,
  type RunIdentity,
} from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { ensureError } from '@utils/errors/errorMessage';

/** What one process turn reports as it returns. */
export interface ProcessReport {
  /** The delivery its parent reads (`formatDelivery`). */
  readonly report: string;
  /** A failure the process reported without throwing (a failed exit, an
   *  SDK's error result): the run ends failed with it, its report still
   *  delivered. */
  readonly failure?: string;
  /** How a command exited, recorded as the run's `process.exit` row. */
  readonly exit?: ProcessExit;
}

/** A process child's one turn, built around the run's trace. */
export interface ProcessTurn {
  /** The stage opened on the run's trace for the turn ("Codex session"). */
  readonly stageLabel: string;
  /** The turn: the whole process, its output on the trace, over the
   *  process's services (a spawner, the filesystem). A stop interrupts it:
   *  a foreign call takes its signal from that interruption
   *  (`Effect.abortSignal`). */
  readonly run: Effect.Effect<ProcessReport, Error, PlatformServices>;
  /** The delivery of a turn that threw. */
  readonly reportError: (error: Error) => string;
}

/**
 * A process child as the tool launching it describes it: how it reads
 * (`identity`), its record, its task label, and the turn built around the
 * trace of the run the launch registered.
 */
export interface ProcessChildLaunch {
  readonly identity: Extract<RunIdentity, { kind: 'agent' | 'process' }>;
  readonly config: RunRecord;
  readonly description: string;
  /** The turn, built around the trace of the run the launch registered. */
  readonly turn: (ctx: {
    readonly logger: AgentTrace;
    readonly runId: RunId;
  }) => ProcessTurn;
}

/** What a process run's opening answers: its trace and its turn. */
interface OpenedProcess {
  readonly logger: TraceEmitter;
  readonly turn: ProcessTurn;
}

/**
 * The run on its fiber: the turn under its stage, then its end on every
 * exit, in the one masked region whose exit is the terminal, so a stop
 * landing mid-turn still ends the run. The end's transaction delivers the
 * report ({@link endRunRows}); one that never wrote fails the fiber, its
 * terminal fact gone.
 */
const processRun = (
  runId: RunId,
  { logger, turn }: OpenedProcess,
): Effect.Effect<void, Error, AgentRunServices> =>
  Effect.suspend(() => {
    const stage = logger.openStage(turn.stageLabel);
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Effect.exit(restore(turn.run)), (exit) => {
        const { outcome, error } = endVerdict(
          Exit.map(exit, (report) =>
            report.failure === undefined
              ? RUN_OUTCOME.COMPLETED
              : RUN_OUTCOME.FAILED,
          ),
        );
        stage.end(outcome);
        const ending = endingOf(runId, turn, exit, error);
        return endRunRows({ runId, outcome, ...ending }).pipe(Effect.asVoid);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => logger.close())));
  });

/** What the turn's exit puts on the run's end: a returned turn's report,
 *  its reported failure and its exit; a thrown one's error report; a
 *  stopped one's nothing. */
const endingOf = (
  runId: RunId,
  turn: ProcessTurn,
  exit: Exit.Exit<ProcessReport, Error>,
  thrown: unknown,
): {
  readonly report: string | null;
  readonly error?: RunEnd['error'];
  readonly leading: readonly UnfoldedDraft[];
} => {
  if (Exit.isSuccess(exit)) {
    const { report, failure, exit: processExit } = exit.value;
    return {
      report,
      ...(failure !== undefined && {
        error: { kind: 'unexpected', message: failure },
      }),
      leading:
        processExit === undefined
          ? []
          : [
              {
                type: 'process.exit',
                aggregateId: qualifyAggregateId('run', runId),
                ...processExit,
              },
            ],
    };
  }
  if (thrown === undefined) return { report: null, leading: [] };
  const error = ensureError(thrown);
  return {
    report: turn.reportError(error),
    error: classifyAgentError(error),
    leading: [],
  };
};

/**
 * Launch a process child of the calling run: register it under the call
 * (its registration commits in this fiber, so a launch that fails before
 * the run exists fails here with no run behind it), build its turn around
 * its trace, and fork the run on the session's registry. Answers its run
 * id once the run is forked.
 */
export const launchProcessChild = Effect.fn('launchProcessChild')(function* (
  parent: { readonly runId: RunId; readonly logId: string },
  launch: ProcessChildLaunch,
): Effect.fn.Return<RunId, Error, AgentRunServices | ToolContext> {
  const runId = generateRunId();
  const log = yield* SessionLog;
  const { callId } = yield* ToolContext;
  const open = Effect.gen(function* () {
    yield* registerRun(runId, launch.config, {
      identity: launch.identity,
      takesFollowUps: false,
      parentRunId: parent.runId,
      parentCall: { callId, card: parent.logId, awaited: false },
      description: childRunDescription(launch.description),
    });
    const logger = new TraceEmitter((event) => log.publish(runId, event));
    const turn = launch.turn({ logger, runId });
    return { logger, turn } satisfies OpenedProcess;
  });
  yield* registryOf(yield* Runs).start(runId, {
    open,
    run: (opened) => processRun(runId, opened),
  });
  return runId;
});
