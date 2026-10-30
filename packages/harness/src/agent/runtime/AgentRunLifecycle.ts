/**
 * How a run ends: the one end of an activation ({@link endActivation}),
 * which the run program's terminal ({@link endRun}) and a child loop's exit
 * reach, and the classification of a failed exit into the `run.end` row's
 * error and the report the caller receives.
 */
import { Cause, Effect, Exit, Result } from 'effect';

import { logSdkError, type ResultEvent, type StageHandle } from '@agent/trace';
import {
  finalizeRun,
  type FinalizeRunInput,
} from '@agent/storage/runLifecycle';
import {
  AGENT_ERROR_OUTCOME,
  agentErrorPresentation,
  classifyAgentError,
} from '@common/errors/agentErrorClassification';
import { AgentError } from '@common/errors/agentErrors';
import {
  attachErrorPresentationClaimed,
  attachProviderError,
} from '@common/errors/sdkError/errorMetadata';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import type { RunOutcome } from '@shared/schemas';
import {
  emptyRunEndOutput,
  RUN_OUTCOME,
  toRetryErrorInfo,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import type { RunReport } from './runReport';
import type { ChildRunTurns } from './childRunLoop';
import type { SessionHandle } from './SessionHandle';
import type { RunLaunch } from './run/AgentRun';

const CHANNEL = 'agentRunLifecycle';

/** A lifecycle diagnostic: guarded cleanup logs past its failure here. */
const logLifecycleWarning = (message: string, data: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data }),
    withLogChannel(CHANNEL),
  );

/** What ends an activation: the run's end, on the session that owns the
 *  publisher every row of the run goes through in order. */
interface EndActivationParams extends FinalizeRunInput {
  readonly session: SessionHandle;
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
 * its end, and a refusal of one of them is the end's own write failure. A
 * stop that reached the run before its end (`stopped`) outranks the run's
 * own report, on the stage and on the row. Its callers: the run program's
 * terminal ({@link endRun}), a child loop's exit, and an end no driver
 * writes (a failed hand-off).
 */
export const endActivation = Effect.fn('endActivation')(
  function* (
    params: EndActivationParams,
  ): Effect.fn.Return<EndActivationResult, Error> {
    const { session, runId } = params;
    // Stop precedence, read once: a stop that reached the run before its exit
    // outranks the flow's report, on the stage here as on the row below.
    const outcome =
      params.stopped === true ? RUN_OUTCOME.CANCELLED : params.outcome;
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
    const finalization = yield* finalizeRun(session, {
      runId,
      outcome,
      error,
      output,
      lastTurn: params.lastTurn,
      ownerless: params.ownerless,
      stopped: params.stopped,
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
    const failed = { kind: classifyAgentError(unsaved), message };
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

/** A child's last turn, finished under the outcome its end resolves. */
type FinishLastTurn = ChildRunTurns<RunReport>['finishLastTurn'];

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
const endWith = (
  ctx: RunLaunch,
  finish: FinishLastTurn | undefined,
  end: Pick<FinalizeRunInput, 'outcome' | 'error' | 'output' | 'stopped'> & {
    readonly lastResult?: RunReport;
  },
) => {
  const { lastResult, ...facts } = end;
  return endActivation({
    session: ctx.session,
    runId: ctx.runId,
    stage: ctx.parentStage,
    ...facts,
    ...(lastResult && finish
      ? { lastTurn: (o) => finish(withResolvedOutcome(lastResult, o)) }
      : {}),
  });
};

/**
 * The single owner of provider/runtime failure exits: a flow carrying
 * structured error metadata (`carried`), or an exception that escaped it.
 * A stop that met the failure (`stopped`) outranks it: the failure rides
 * the cancelled row as its error.
 */
const failedEnd = Effect.fn('failedEnd')(function* (
  ctx: RunLaunch,
  finish: FinishLastTurn | undefined,
  err: unknown,
  carried: RunReport | undefined,
  stopped = false,
) {
  const { runId } = ctx;
  const agentIdentifier = ctx.config.agent;
  // Read once as the run entered: a child detached mid-run ends as a child.
  const parentRunId = ctx.entry.parent;
  // A throw in this fallible prologue must not strand the run without its
  // terminal: it falls back to an unexpected failure.
  const prologue = yield* Effect.exit(
    Effect.gen(function* () {
      const kind = classifyAgentError(err);
      // toRetryErrorInfo strips rawErrorBody, which the `run.end` error
      // type omits and a bare object spread would smuggle past the check.
      const info = toRetryErrorInfo(normalizeProviderError(err));
      const { message: sdkMsg, ...providerErrorInfo } = info;
      const errorMsg = `Error executing agent ${agentIdentifier}: ${sdkMsg}`;
      // Root failures are logged here; a subagent's is delivered to its
      // orchestrator, so a second wrapper error would blame the parent.
      if (kind !== 'abort' && parentRunId === null) {
        yield* logSdkError(ctx.logger, errorMsg, err, {
          operation: `execute ${agentIdentifier}`,
        });
      }
      const message = kind === 'unexpected' ? errorMsg : sdkMsg;
      // `abort`/`disk-full` never carry provider or credential fields:
      // narrow them so runRecords' union stays honest.
      const error: NonNullable<ResultEvent['error']> =
        kind === 'abort' || kind === 'disk-full'
          ? {
              kind,
              message,
              userRetryable: providerErrorInfo.userRetryable,
              partialText: providerErrorInfo.partialText,
            }
          : { kind, message, ...providerErrorInfo };
      return { kind, errorMsg, error, info };
    }),
  );
  const fallbackMsg = `Error executing agent ${agentIdentifier}: ${toErrorMessage(err)}`;
  const { kind, errorMsg, error, info } = Exit.isSuccess(prologue)
    ? prologue.value
    : yield* logLifecycleWarning('Run failure prologue failed', {
        runId,
        error: Cause.squash(prologue.cause),
      }).pipe(
        Effect.as({
          kind: 'unexpected' as const,
          errorMsg: fallbackMsg,
          error: { kind: 'unexpected' as const, message: fallbackMsg },
          info: { message: fallbackMsg, userRetryable: false },
        }),
      );
  const outcome = AGENT_ERROR_OUTCOME[kind];
  // A child's failure rides its result, the error its delivery reports.
  const subagentResult: RunReport | undefined =
    parentRunId !== null
      ? { ...(carried ?? emptyReport(ctx, outcome)), failure: info }
      : undefined;
  // One finalize covers the three exits below.
  const finalized = yield* endWith(ctx, finish, {
    outcome,
    error,
    output: carried?.output,
    stopped,
    lastResult: subagentResult,
  });
  // The exits below report the terminal fact the finalizer published.
  const resolvedOutcome = finalized.event.outcome;
  if (subagentResult) {
    return withResolvedOutcome(subagentResult, resolvedOutcome);
  }
  if (kind === 'abort') return emptyReport(ctx, resolvedOutcome);

  const failure = new AgentError({ message: errorMsg, cause: err });
  // Receipt for a root run's failure once its `run.end` row committed: the
  // session's presenter shows that row's guidance, so the failure thrown
  // past it is marked presented. A run that never opened has no row: its
  // launch presents it (`Runs.launch`).
  const recorded = finalized.event.error;
  if (finalized.recorded && recorded && agentErrorPresentation(recorded))
    attachErrorPresentationClaimed(failure);
  return yield* failure;
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
export const endRun = Effect.fn('endRun')(function* (
  ctx: RunLaunch,
  exit: Exit.Exit<RunReport, Error>,
  /** A child's last turn result, from the result its run ends with. */
  finish?: FinishLastTurn,
): Effect.fn.Return<RunReport, Error> {
  if (Exit.isSuccess(exit)) {
    const result = exit.value;
    if (result.failure) {
      // The carried failure as an `Error`, so the one failure path
      // classifies and logs it exactly as an exception that escaped the
      // flow. `RetryErrorInfo` is a `ProviderError` minus the bulky
      // `rawErrorBody`, so it attaches as-is: its classification is what
      // the classifier reads.
      const failure = new Error(result.failure.message);
      attachProviderError(failure, result.failure);
      return yield* failedEnd(ctx, finish, failure, result);
    }
    // The phase decides the verdict here exactly as on a failure: a stop
    // that won on the phase must not let the caller observe COMPLETED.
    const { event, persistFailure: cause } = yield* endWith(ctx, finish, {
      outcome: result.outcome,
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
    yield* endWith(ctx, finish, {
      outcome: RUN_OUTCOME.CANCELLED,
      stopped: true,
    }).pipe(Effect.orDie);
    return yield* Effect.failCause(cause);
  }
  const err = ensureError(Cause.squash(cause));
  if (!Cause.hasInterrupts(cause))
    return yield* failedEnd(ctx, finish, err, undefined);
  // A stop that met a failure (a finalizer that died or failed as the
  // stop unwound it) is still a stop, as `outcomeFromCause` keys it: the row
  // says CANCELLED and carries the failure, which is logged, not lost.
  yield* logLifecycleWarning('A stopped run also failed', {
    runId: ctx.runId,
    error: err,
  });
  return yield* failedEnd(ctx, finish, err, undefined, true);
}, Effect.uninterruptible);
