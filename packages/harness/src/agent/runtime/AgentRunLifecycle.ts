/**
 * How a run ends: the one end of an activation ({@link endActivation}),
 * which the run program's terminal ({@link endRun}) and a child loop's exit
 * reach, and the classification of a failed exit into the `run.end` row's
 * error and the report the caller receives.
 */
import { Cause, Effect, Exit, Result } from 'effect';

import type { StageHandle } from '@agent/trace/AgentTrace';
import { logSdkError } from '@agent/trace/helpers';
import {
  finalizeRun,
  type FinalizeRunInput,
} from '@agent/storage/runLifecycle';
import { Runs } from '@agent/runtime/runRegistry';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { AgentError } from '@common/errors/agentErrors';
import { withLogChannel } from '@logger/effectLog';
import { outcomeFromCause } from '@shared/runs/runStatus';
import type { ResultEvent } from '@shared/session/agentEvent';
import {
  type RunOutcome,
  type RunStopReason,
  emptyRunEndOutput,
  RUN_OUTCOME,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import type { RunReport } from './runReport';
import type { ChildRunTurns } from './childRunLoop';
import type { StopCause } from './runs';
import type { SessionServices } from './rootLaunch';
import type { RunLaunch } from './run/AgentRun';

const CHANNEL = 'agentRunLifecycle';

/** A lifecycle diagnostic: guarded cleanup logs past its failure here. */
const logLifecycleWarning = (message: string, data: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data }),
    withLogChannel(CHANNEL),
  );

/** How an activation ends, as {@link endVerdict} decides it. */
export interface EndVerdict {
  readonly outcome: RunOutcome;
  /** What the run failed with, a stopped run's failure included. */
  readonly error?: unknown;
  /** Why it stopped, on a cancelled end: a person's stop or a shutdown. */
  readonly reason?: RunStopReason;
}

/**
 * The one verdict of how a run's activation ends, from its body's exit (the
 * outcome it returned, or the cause it failed with) and why the registry
 * marked it stopping. A returned outcome stands, a stop marked after it
 * included. A failure cause with any interrupt is a stop
 * (`outcomeFromCause`), which outranks a failure: the failure rides the
 * cancelled end as its error. A release names no reason.
 */
export function endVerdict(
  exit: Exit.Exit<RunOutcome, unknown>,
  stopCause: StopCause | undefined,
): EndVerdict {
  if (Exit.isSuccess(exit))
    return exit.value === RUN_OUTCOME.CANCELLED
      ? stoppedVerdict(stopCause)
      : { outcome: exit.value };
  const { cause } = exit;
  const verdict =
    outcomeFromCause(cause) === RUN_OUTCOME.CANCELLED
      ? stoppedVerdict(stopCause)
      : { outcome: RUN_OUTCOME.FAILED };
  return Cause.hasInterruptsOnly(cause)
    ? verdict
    : { ...verdict, error: Cause.squash(cause) };
}

/** A cancelled verdict, with the reason a person's stop or a shutdown gave. */
const stoppedVerdict = (stopCause: StopCause | undefined): EndVerdict =>
  stopCause === undefined || stopCause === 'released'
    ? { outcome: RUN_OUTCOME.CANCELLED }
    : { outcome: RUN_OUTCOME.CANCELLED, reason: stopCause };

/** What ends an activation: the run's end, on the caller's session, whose
 *  publisher every row of the run goes through in order. */
interface EndActivationParams<R = never> extends FinalizeRunInput<R> {
  /** Transcript stage closed with the resolved outcome (guarded). */
  readonly stage?: Pick<StageHandle, 'end'>;
}

interface EndActivationResult {
  readonly event: ResultEvent;
  /** The `run.end` row write's failure: the terminal still ran, and the
   *  event reports FAILED with its reason. */
  readonly persistFailure?: Error;
  /** False when no `run.end` is recorded: a run that never opened, whose
   *  failure is its launch's to present, or a child whose end waits for its
   *  held result's delivery. */
  readonly recorded: boolean;
}

/**
 * The one end of a run's activation, in this order: the transcript stage
 * end, then the `run.end` row (through `finalizeRun`, its one writer). The
 * publisher commits in order, so every row the run published lands before
 * its end, and a refusal of one of them is the end's own write failure. The
 * outcome is the run's verdict, a stop's CANCELLED included, on the stage
 * and on the row. Its callers: the run program's
 * terminal ({@link endRun}), a child loop's exit, and an end no driver
 * writes (a failed hand-off).
 */
export const endActivation = Effect.fn('endActivation')(
  function* <R = never>(
    params: EndActivationParams<R>,
  ): Effect.fn.Return<EndActivationResult, Error, SessionServices | R> {
    const { runId, outcome } = params;
    // Close the transcript stage first: its `stage.end` is published ahead of
    // the `run.end` row, and a refusal of it is that row's write failure.
    if (params.stage) {
      const stage = params.stage;
      yield* Effect.try({
        try: () => stage.end(outcome),
        catch: ensureError,
      }).pipe(
        Effect.catch((stageErr) =>
          logLifecycleWarning('Failed to end parent stage', {
            runId,
            error: stageErr,
          }),
        ),
      );
    }
    const { error } = params;
    const output = params.output ?? emptyRunEndOutput();
    // `finalizeRun` resolves a lost trace row and adds the usage totals;
    // the event is the end it wrote, or this activation's own report where
    // it wrote none (an earlier end stands, or a held result waits).
    const event: ResultEvent = {
      type: 'run.end',
      outcome,
      runId,
      ...(error ? { error } : {}),
      output,
    };
    const finalization = yield* finalizeRun({
      runId,
      outcome,
      reason: params.reason,
      error,
      output,
      lastTurn: params.lastTurn,
      ownerless: params.ownerless,
    }).pipe(Effect.result);
    if (Result.isSuccess(finalization)) {
      const { end, wrote } = finalization.success;
      return end !== null && wrote
        ? { event: { type: 'run.end', runId, ...end }, recorded: true }
        : { event, recorded: end !== null };
    }
    // A run whose `run.end` did not commit failed, whatever it reported.
    const unsaved = finalization.failure;
    yield* logLifecycleWarning('Failed to finalize durable run state', {
      runId,
      error: unsaved,
    });
    const message = `The run's end could not be saved: ${unsaved.message}`;
    const failed = { ...classifyAgentError(unsaved), message };
    return {
      event: { ...event, outcome: RUN_OUTCOME.FAILED, error: failed },
      persistFailure: unsaved,
      recorded: false,
    };
  },
  // The run's terminal is atomic: the run's stop is its fiber's interruption,
  // and one landing mid-way must not strand the run with no `run.end` row.
  // A stop lands either before this finalizer or after its row, never inside.
  Effect.uninterruptible,
);

/** A child's last turn, finished under the outcome its end resolves; `R`,
 *  what finishing it reads of the run. */
type FinishLastTurn<R> = ChildRunTurns<RunReport, R>['finishLastTurn'];

/** The report of a run that ended before its loop produced an output. */
function emptyReport(ctx: RunLaunch, outcome: RunOutcome): RunReport {
  const misses = ctx.opening?.attachedMemoryMisses ?? [];
  const report = { outcome, output: emptyRunEndOutput(), runId: ctx.runId };
  return misses.length > 0 ? { ...report, memoryMisses: misses } : report;
}

/**
 * The run's own flow result, relabelled with the outcome finalization resolved.
 *
 * A flow reports the exit it saw; stop precedence decides the run's terminal
 * fact, and the `run.end` row carries the verdict. Everything the parent
 * receives has to carry that same verdict, or an orchestrator formats a
 * failure for a run whose durable record says cancelled.
 */
function withResolvedOutcome(
  result: RunReport,
  outcome: RunOutcome,
): RunReport {
  if (result.outcome === outcome) return result;
  return { ...result, outcome };
}

/** End the run's activation with `end`'s facts; a child's last turn
 *  (`lastResult`) is finished under the resolved outcome. */
const endWith = <R>(
  ctx: RunLaunch,
  finish: FinishLastTurn<R> | undefined,
  end: Pick<FinalizeRunInput, 'outcome' | 'reason' | 'error' | 'output'> & {
    readonly lastResult?: RunReport;
  },
) => {
  const { lastResult, ...facts } = end;
  return endActivation({
    runId: ctx.runId,
    stage: ctx.parentStage,
    ...facts,
    ...(lastResult && finish
      ? { lastTurn: (o) => finish(withResolvedOutcome(lastResult, o)) }
      : {}),
  });
};

/**
 * The single owner of provider/runtime failure exits: a flow's reported
 * failure (an `AgentError` carrying it as recorded) or an exception that
 * escaped the flow, ending as `verdict` says: a stop that met the failure
 * outranks it, and the failure rides the cancelled row as its error.
 */
const failedEnd = Effect.fn('failedEnd')(function* <R>(
  ctx: RunLaunch,
  finish: FinishLastTurn<R> | undefined,
  err: unknown,
  carried: RunReport | undefined,
  verdict: EndVerdict,
) {
  const { runId } = ctx;
  const agentIdentifier = ctx.config.agent;
  // Read once as the run entered: a child detached mid-run ends as a child.
  const parentRunId = ctx.entry.parent;
  // A throw in this fallible prologue must not strand the run without its
  // terminal: it falls back to an unexpected failure.
  const prologue = yield* Effect.exit(
    Effect.gen(function* () {
      const classified = classifyAgentError(err);
      // An unexpected failure is named by the agent it stopped; a model
      // failure names its own cause, as the other kinds do, and a host may
      // word it from its classification in place of this message.
      const error: NonNullable<ResultEvent['error']> =
        classified.kind === 'unexpected'
          ? {
              kind: 'unexpected',
              message: `Error executing agent ${agentIdentifier}: ${classified.message}`,
            }
          : classified;
      // Root failures are logged here; a subagent's is delivered to its
      // orchestrator, so a second wrapper error would blame the parent.
      if (parentRunId === null) {
        yield* logSdkError(ctx.logger, error.message, err, {
          operation: `execute ${agentIdentifier}`,
        });
      }
      return error;
    }),
  );
  const error: NonNullable<ResultEvent['error']> = Exit.isSuccess(prologue)
    ? prologue.value
    : yield* logLifecycleWarning('Run failure prologue failed', {
        runId,
        error: Cause.squash(prologue.cause),
      }).pipe(
        Effect.as({
          kind: 'unexpected' as const,
          message: `Error executing agent ${agentIdentifier}: ${toErrorMessage(err)}`,
        }),
      );
  // The failure a child's report and a root's `AgentError` carry: the error
  // without its kind, a model failure as recorded or the words alone.
  const { kind: _kind, ...failure } = error;
  const { outcome, reason } = verdict;
  // A child's failure rides its result, the error its delivery reports.
  const subagentResult: RunReport | undefined =
    parentRunId !== null
      ? { ...(carried ?? emptyReport(ctx, outcome)), failure }
      : undefined;
  // One finalize covers the three exits below.
  const finalized = yield* endWith(ctx, finish, {
    outcome,
    reason,
    error,
    output: carried?.output,
    lastResult: subagentResult,
  });
  // The exits below report the terminal fact the finalizer published.
  const resolvedOutcome = finalized.event.outcome;
  if (subagentResult) {
    return withResolvedOutcome(subagentResult, resolvedOutcome);
  }

  // A root run's failure. Once its `run.end` row committed, the session's
  // presenter shows that row (`presentTerminalResult`), and a launch that
  // waits for the run's opening answers with the opening, not this; a run
  // that never opened has no row, so its launch's caller presents this.
  return yield* new AgentError({
    message: error.message,
    cause: err,
    ...(error.kind === 'model' ? { failure } : {}),
  });
});

/**
 * The run program's terminal, the run's one terminal writer: every way the
 * flow exits — a result, a reported failure, an escaped exception, a stop —
 * reaches this verdict exactly once, as the exit of the one masked region
 * the program runs in. Provider/runtime failures carry structured error
 * metadata and take the classified failure path; a domain failure may
 * report FAILED without it and finalizes as an outcome-only terminal
 * result. Uninterruptible: the run's stop is its fiber's interruption, and
 * one landing mid-way must not strand the run with no `run.end` row.
 */
export const endRun = Effect.fn('endRun')(function* <R = never>(
  ctx: RunLaunch,
  exit: Exit.Exit<RunReport, Error>,
  /** A child's last turn result, from the result its run ends with. */
  finish?: FinishLastTurn<R>,
): Effect.fn.Return<RunReport, Error, SessionServices | R> {
  const verdict = endVerdict(
    Exit.map(exit, (result) =>
      result.failure ? RUN_OUTCOME.FAILED : result.outcome,
    ),
    (yield* Runs).stopCause(ctx.runId),
  );
  const { outcome, reason } = verdict;
  if (Exit.isSuccess(exit)) {
    const result = exit.value;
    if (result.failure) {
      // The reported failure takes the one failure path on an `AgentError`,
      // which that path's log row and the root's error read it from.
      const failure = new AgentError({
        message: result.failure.message,
        failure: result.failure,
      });
      return yield* failedEnd(ctx, finish, failure, result, verdict);
    }
    // A completed flow supplies its outcome; an interrupted flow arrives
    // as a failed Exit and is classified below.
    const { event, persistFailure: cause } = yield* endWith(ctx, finish, {
      outcome,
      reason,
      output: result.output,
      lastResult: result,
    });
    // An end that did not save fails the run, saying why.
    if (cause !== undefined)
      return yield* new AgentError({
        message: event.error?.message ?? '',
        cause,
      });
    return withResolvedOutcome(result, event.outcome);
  }
  const { cause } = exit;
  // The run's stop is its fiber's interruption, and this is its verdict:
  // the terminal result completes before cleanup, and the interruption
  // stays the exit. An interruption the program raised on itself (a
  // prompt closed under it) is a stop too, not a failure: squashed, it
  // would record "All fibers interrupted without error" as FAILED.
  if (Cause.hasInterruptsOnly(cause)) {
    yield* endWith(ctx, finish, { outcome, reason }).pipe(Effect.orDie);
    return yield* Effect.failCause(cause);
  }
  const err = ensureError(verdict.error);
  // A stop that met a failure (a finalizer that died or failed as the
  // stop unwound it) is still a stop: the row says CANCELLED and carries
  // the failure, which is logged, not lost.
  if (outcome === RUN_OUTCOME.CANCELLED)
    yield* logLifecycleWarning('A stopped run also failed', {
      runId: ctx.runId,
      error: err,
    });
  return yield* failedEnd(ctx, finish, err, undefined, verdict);
}, Effect.uninterruptible);
