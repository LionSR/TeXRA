/**
 * A process child: a run whose one turn an external process is (a
 * background shell, a coding agent's CLI). The tool launching it supplies
 * the turn ({@link ProcessChildLaunch}); the harness registers the run
 * under the launching call, forks the turn under the run's id on the
 * session's registry, and ends the run with what the turn reports: its
 * delivery (`run.report`, queued on the parent's input by the end's
 * transaction), the process's exit (`process.exit`), and its failure: an
 * exit other than 0, or the failure a provider's SDK reported with no exit
 * of its own. The process's output goes to the run's trace as it
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
import { RunRegistry, type AgentRunServices } from '@agent/runtime/runRegistry';
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
  /** How a command exited, recorded as the run's `process.exit` row: a
   *  code other than 0 ends the run failed, its report still delivered. */
  readonly exit?: ProcessExit;
  /** A failure a process with no exit of its own reported without
   *  throwing (an SDK's error result): the run ends failed with it, its
   *  report still delivered. */
  readonly failure?: string;
}

/** A process child's one turn, built around the run's trace. */
export interface ProcessTurn {
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
 * The run on its fiber: the turn, then its end on every
 * exit, in the one masked region whose exit is the terminal, so a stop
 * landing mid-turn still ends the run. The end's transaction delivers the
 * report ({@link endRunRows}); one that never wrote fails the fiber, its
 * terminal fact gone.
 */
const runProcessChild = (
  runId: RunId,
  { logger, turn }: OpenedProcess,
): Effect.Effect<void, Error, AgentRunServices> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.exit(restore(turn.run)), (exit) => {
      const { outcome, error } = endVerdict(
        Exit.map(exit, (report) =>
          failureOf(report) === undefined
            ? RUN_OUTCOME.COMPLETED
            : RUN_OUTCOME.FAILED,
        ),
      );
      const ending = endingOf(runId, turn, exit, error);
      return endRunRows({ runId, outcome, ...ending }).pipe(Effect.asVoid);
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => logger.close())));

/** A returned turn's failure: its exit's, or the one it reported. */
const failureOf = ({ exit, failure }: ProcessReport): string | undefined => {
  if (exit === undefined || exit.code === 0) return failure;
  if (exit.code === null)
    return `The command ended with no exit code${exit.timedOut ? ' (timed out)' : ''}.`;
  return `The command failed with exit code ${exit.code}${exit.timedOut ? ' (timed out)' : ''}.`;
};

/** What the turn's exit puts on the run's end: a returned turn's report,
 *  its failure and its exit; a thrown one's error report; a stopped one's
 *  nothing. */
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
    const { report, exit: processExit } = exit.value;
    const failure = failureOf(exit.value);
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
  yield* (yield* RunRegistry).start(runId, {
    open,
    run: (opened) => runProcessChild(runId, opened),
  });
  return runId;
});
