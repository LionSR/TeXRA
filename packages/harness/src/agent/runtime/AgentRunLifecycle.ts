/**
 * How a run ends: the one verdict of its outcome ({@link endVerdict}), and
 * the one end both run programs commit with it ({@link commitEnd}), a
 * native run's terminal ({@link endRun}) and a process child's
 * (`processRun.ts`), which commits the run's `run.end` and report in one
 * transaction. Callers read that end.
 */
import { Cause, Clock, Effect, Exit } from 'effect';

import { logSdkError } from '@agent/trace/traceLogs';
import {
  endRunRows,
  RUN_LIFECYCLE_CHANNEL,
  type RunEnding,
} from '@agent/storage/runLifecycle';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { AgentError } from '@common/errors/agentErrors';
import { logFailure, withLogChannel } from '@logger/effectLog';
import type { ResultEvent } from '@shared/session/agentEvent';
import { SessionLog } from '@shared/session/runHistory';
import {
  runEndErrorMessage,
  type RunEnd,
  type RunId,
  type RunOutcome,
  emptyRunEndOutput,
  outcomeFromCause,
  RUN_OUTCOME,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { childEndReport } from './childDelivery';
import type { RunReport } from './runReport';
import { RunRegistry, type AgentRunServices } from './runRegistry';
import type { RunLaunch } from './run/AgentRun';

/** How a run ends, as {@link endVerdict} decides it. */
interface EndVerdict {
  /** The outcome the run's `run.end` commits. */
  readonly outcome: RunOutcome;
  /** What the run's fiber failed with, a stopped run's failure included. */
  readonly thrown: unknown;
  /** Rows the store refused: the run's error unless it has one of its
   *  own. */
  readonly lost: RunEnd['error'] | undefined;
}

/**
 * The one verdict of how a run ends, which both run programs read before
 * they build the run's report and commit its end ({@link commitEnd}); no
 * one decides the outcome again after it. From the fiber's exit: the
 * outcome it returned, or the cause it failed with. A failure cause with
 * any interrupt is a stop (`outcomeFromCause`), which outranks a failure:
 * the failure rides the cancelled end as its error. Why a stopped run
 * stopped is its `run.stop` row, not the exit's. From the store: rows it
 * refused (`log.lost`) fail the run unless a stop ended it, whoever ends
 * it.
 *
 * A run the session's close interrupted, with no stop asked, gets no
 * verdict and no end: this fails with the exit's cause, and the run is
 * left as its rows stand, to read as interrupted, resumable, at the next
 * open, as after a crash.
 */
export const endVerdict = Effect.fnUntraced(function* (
  runId: RunId,
  exit: Exit.Exit<RunOutcome, Error>,
): Effect.fn.Return<EndVerdict, Error, RunRegistry | SessionLog> {
  const log = yield* SessionLog;
  if (
    Exit.isFailure(exit) &&
    Cause.hasInterrupts(exit.cause) &&
    (yield* RunRegistry).closing &&
    (yield* log.facts(runId))?.stop == null
  ) {
    // Nobody reads this fiber's exit, so a failure beside the interruption
    // (a finalizer that failed as the close unwound it) is said here.
    if (!Cause.hasInterruptsOnly(exit.cause))
      yield* logFailure(
        RUN_LIFECYCLE_CHANNEL,
        `Run ${runId} also failed as the session closed`,
      )({ runId, error: Cause.squash(exit.cause) });
    return yield* Effect.failCause(exit.cause);
  }
  const lost = yield* log.lost(runId);
  const returned = Exit.isSuccess(exit)
    ? exit.value
    : outcomeFromCause(exit.cause);
  return {
    outcome:
      lost !== undefined && returned !== RUN_OUTCOME.CANCELLED
        ? RUN_OUTCOME.FAILED
        : returned,
    thrown:
      Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
        ? undefined
        : Cause.squash(exit.cause),
    lost,
  };
});

/** The report of a run that ended before its loop produced an output. */
function emptyReport(ctx: RunLaunch, outcome: RunOutcome): RunReport {
  const misses = ctx.opening?.attachedMemoryMisses ?? [];
  const report = { outcome, output: emptyRunEndOutput(), runId: ctx.runId };
  return misses.length > 0 ? { ...report, memoryMisses: misses } : report;
}

/**
 * The one end both run programs commit, with the outcome their verdict
 * reached ({@link endVerdict}) and the report they built from it: the
 * `run.end` commits in one transaction with everything the end decides
 * (`endRunRows`), the report's delivery among them; an end the store
 * refused fails the fiber once, logged, and the run reads as interrupted
 * at its next open; and a stop stays the fiber's exit once the end
 * committed. Uninterruptible: a stop lands before this or after its row,
 * never inside.
 */
export const commitEnd = Effect.fn('commitEnd')(function* (
  exit: Exit.Exit<unknown, Error>,
  ending: RunEnding,
): Effect.fn.Return<void, Error, AgentRunServices> {
  const { runId } = ending;
  const ended = yield* endRunRows(ending).pipe(
    Effect.tapError((unsaved) =>
      logFailure(
        RUN_LIFECYCLE_CHANNEL,
        `Run ${runId}: its end could not be saved`,
      )({
        runId,
        error: unsaved,
      }),
    ),
  );
  const resolved = ended.end?.outcome ?? ending.outcome;
  yield* Effect.logDebug(`Task completed with outcome: ${resolved}`).pipe(
    withLogChannel(RUN_LIFECYCLE_CHANNEL),
  );
  // The run's stop is its fiber's interruption: the end commits, and the
  // interruption stays the exit.
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
    return yield* Effect.failCause(exit.cause);
}, Effect.uninterruptible);

/**
 * The run program's terminal, the run's one terminal writer: every way the
 * flow exits (a result, a reported failure, an escaped exception, a stop)
 * reaches this exactly once, as the exit of the one masked region the
 * program runs in. It ends the run through {@link commitEnd}, its report
 * with the delivery to the runs it worked for in the end's transaction
 * (`childEndReport`), whether the flow returned one or died. A root's
 * failure is also logged here and raised as an `AgentError` once its end
 * committed.
 * Uninterruptible, as that end is.
 */
export const endRun = Effect.fn('endRun')(function* (
  ctx: RunLaunch,
  exit: Exit.Exit<RunReport, Error>,
): Effect.fn.Return<void, Error, AgentRunServices> {
  const { runId } = ctx;
  const agentIdentifier = ctx.config.agent;
  const carried = Exit.isSuccess(exit) ? exit.value : undefined;
  const verdict = yield* endVerdict(
    runId,
    Exit.map(exit, (result) =>
      result.failure ? RUN_OUTCOME.FAILED : result.outcome,
    ),
  );
  // The run's failure: the one its flow reported, or the cause it died
  // with, classified. An unexpected failure is named by the agent it
  // stopped; a model failure names its own cause, as the other kinds do.
  const thrown =
    carried?.failure !== undefined
      ? new AgentError({
          message: runEndErrorMessage(carried.failure),
          ...(carried.failure.kind === 'model' && {
            failure: carried.failure.failure,
          }),
        })
      : verdict.thrown !== undefined
        ? ensureError(verdict.thrown)
        : undefined;
  const error: ResultEvent['error'] | undefined =
    thrown === undefined
      ? undefined
      : (() => {
          const classified = classifyAgentError(thrown);
          return classified.kind === 'unexpected'
            ? {
                kind: 'unexpected',
                message: `Error executing agent ${agentIdentifier}: ${classified.message}`,
              }
            : classified;
        })();
  // Read once as the run entered.
  const parentId = ctx.entry.parent;
  if (thrown !== undefined && error !== undefined) {
    if (verdict.outcome === RUN_OUTCOME.CANCELLED)
      // A stop that met a failure (a finalizer that died or failed as the
      // stop unwound it) is still a stop: the row says CANCELLED and
      // carries the failure, which is logged, not lost.
      yield* logFailure(
        RUN_LIFECYCLE_CHANNEL,
        'A stopped run also failed',
      )({
        runId,
        error: thrown,
      });
    // A root's failure is logged here; a child's is delivered to its
    // orchestrator, so a second wrapper error would blame the parent.
    if (parentId === null)
      yield* logSdkError(ctx.logger, runEndErrorMessage(error), thrown, {
        operation: `execute ${agentIdentifier}`,
      });
  }
  // The run's failure rides its report, the error its delivery reports: a
  // run that died before returning one reports that, root or child; one
  // with no failure of its own reports the rows the store refused.
  const failure = error ?? verdict.lost;
  const report: RunReport = {
    ...(carried ?? emptyReport(ctx, verdict.outcome)),
    outcome: verdict.outcome,
    ...(failure !== undefined && { failure }),
  };
  yield* commitEnd(exit, {
    runId,
    outcome: verdict.outcome,
    error: failure,
    output: carried?.output,
    // What the run tells the runs it worked for.
    report: yield* childEndReport(
      ctx,
      report,
      yield* (yield* SessionLog).facts(runId),
      (yield* Clock.currentTimeMillis) - ctx.startedAt,
    ),
  });
  if (parentId === null && thrown !== undefined && error !== undefined)
    // A root run's failure. Once its `run.end` row committed, the
    // session's presenter shows that row (`presentTerminalResult`); a run
    // that never opened has no row, so its launch's caller presents this.
    return yield* new AgentError({
      message: runEndErrorMessage(error),
      cause: thrown,
      ...(error.kind === 'model' && { failure: error.failure }),
    });
}, Effect.uninterruptible);
