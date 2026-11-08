/**
 * How a run ends: the verdict of its fiber's exit, and the one end
 * ({@link endRun}) the run program's terminal reaches, which commits the
 * run's `run.end` and report in one transaction. Callers read that end.
 */
import { Cause, Clock, Effect, Exit } from 'effect';

import { logSdkError } from '@agent/trace/helpers';
import { endRunRows } from '@agent/storage/runLifecycle';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { AgentError } from '@common/errors/agentErrors';
import { withLogChannel } from '@logger/effectLog';
import type { ResultEvent } from '@shared/session/agentEvent';
import { SessionLog } from '@shared/session/runHistory';
import {
  type RunOutcome,
  emptyRunEndOutput,
  outcomeFromCause,
  RUN_OUTCOME,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { childEndReport } from './childDelivery';
import type { RunReport } from './runReport';
import type { AgentRunServices } from './runRegistry';
import type { RunLaunch } from './run/AgentRun';

const CHANNEL = 'agentRunLifecycle';

/** A lifecycle diagnostic: guarded cleanup logs past its failure here. */
const logLifecycleWarning = (message: string, data: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data }),
    withLogChannel(CHANNEL),
  );

/** How a run ends, as {@link endVerdict} decides it. */
export interface EndVerdict {
  readonly outcome: RunOutcome;
  /** What the run failed with, a stopped run's failure included. */
  readonly error?: unknown;
}

/**
 * The one verdict of how a run's fiber ends, from its exit: the outcome it
 * returned, or the cause it failed with. A failure cause with any interrupt
 * is a stop (`outcomeFromCause`), which outranks a failure: the failure
 * rides the cancelled end as its error. Why a stopped run stopped is its
 * `run.stop` row, not the exit's.
 */
export function endVerdict(exit: Exit.Exit<RunOutcome, unknown>): EndVerdict {
  if (Exit.isSuccess(exit)) return { outcome: exit.value };
  const { cause } = exit;
  const outcome =
    outcomeFromCause(cause) === RUN_OUTCOME.CANCELLED
      ? RUN_OUTCOME.CANCELLED
      : RUN_OUTCOME.FAILED;
  return Cause.hasInterruptsOnly(cause)
    ? { outcome }
    : { outcome, error: Cause.squash(cause) };
}

/** The report of a run that ended before its loop produced an output. */
function emptyReport(ctx: RunLaunch, outcome: RunOutcome): RunReport {
  const misses = ctx.opening?.attachedMemoryMisses ?? [];
  const report = { outcome, output: emptyRunEndOutput(), runId: ctx.runId };
  return misses.length > 0 ? { ...report, memoryMisses: misses } : report;
}

/**
 * The run program's terminal, the run's one terminal writer: every way the
 * flow exits (a result, a reported failure, an escaped exception, a stop)
 * reaches this exactly once, as the exit of the one masked region the
 * program runs in. The `run.end`
 * row commits in one transaction with everything the end decides
 * (`endRunRows`): a child's report with its parent's delivery among them
 * (`childEndReport`). An end the store refused fails the fiber once,
 * logged, and the run reads as interrupted at its next open. A root's
 * failure is logged here and raised as an `AgentError` once its end
 * committed; a child's rides its report. Uninterruptible: a stop lands
 * before this or after its row, never inside.
 */
export const endRun = Effect.fn('endRun')(function* (
  ctx: RunLaunch,
  exit: Exit.Exit<RunReport, Error>,
): Effect.fn.Return<void, Error, AgentRunServices> {
  const { runId } = ctx;
  const agentIdentifier = ctx.config.agent;
  const carried = Exit.isSuccess(exit) ? exit.value : undefined;
  const verdict = endVerdict(
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
          message: carried.failure.message,
          failure: carried.failure,
        })
      : verdict.error !== undefined
        ? ensureError(verdict.error)
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
  // Read once as the run entered: a child detached mid-run ends as a child.
  const parentRunId = ctx.entry.parent;
  if (thrown !== undefined && error !== undefined) {
    if (verdict.outcome === RUN_OUTCOME.CANCELLED)
      // A stop that met a failure (a finalizer that died or failed as the
      // stop unwound it) is still a stop: the row says CANCELLED and
      // carries the failure, which is logged, not lost.
      yield* logLifecycleWarning('A stopped run also failed', {
        runId,
        error: thrown,
      });
    // A root's failure is logged here; a child's is delivered to its
    // orchestrator, so a second wrapper error would blame the parent.
    if (parentRunId === null)
      yield* logSdkError(ctx.logger, error.message, thrown, {
        operation: `execute ${agentIdentifier}`,
      });
  }
  // The failure a child's report carries: the error without its kind.
  const failure =
    error === undefined
      ? undefined
      : (({ kind: _kind, ...rest }) => rest)(error);
  // A child's failure rides its result, the error its delivery reports.
  const childResult: RunReport | undefined =
    parentRunId === null
      ? carried
      : {
          ...(carried ?? emptyReport(ctx, verdict.outcome)),
          ...(failure !== undefined && { failure }),
        };
  const log = yield* SessionLog;
  // Rows the store refused fail the run unless a stop ended it, whoever
  // ends it.
  const lost = yield* log.lost(runId);
  const failed =
    lost !== undefined && verdict.outcome !== RUN_OUTCOME.CANCELLED;
  const outcome = failed ? RUN_OUTCOME.FAILED : verdict.outcome;
  // What the child tells its parent, from its report as the end resolves
  // it; a report that cannot be built is the end's error, delivered as
  // such rather than lost.
  const report =
    childResult === undefined
      ? null
      : yield* childEndReport(
          ctx,
          { ...childResult, outcome },
          (yield* log.facts(runId))?.stop?.reason ?? null,
          (yield* Clock.currentTimeMillis) - ctx.startedAt,
        ).pipe(
          Effect.catch((unbuilt) =>
            Effect.as(
              logLifecycleWarning(
                `Run ${runId}: its report could not be built`,
                {
                  runId,
                  error: unbuilt,
                },
              ),
              `The run ${runId} ended ${outcome}, but its report could not be built: ${unbuilt.message}`,
            ),
          ),
        );
  const ended = yield* endRunRows({
    runId,
    outcome,
    error: lost ?? error,
    output: carried?.output,
    report,
  }).pipe(
    Effect.tapError((unsaved) =>
      logLifecycleWarning(`Run ${runId}: its end could not be saved`, {
        runId,
        error: unsaved,
      }),
    ),
  );
  const resolved = ended.end?.outcome ?? outcome;
  yield* Effect.logDebug(`Task completed with outcome: ${resolved}`).pipe(
    withLogChannel(CHANNEL),
  );
  // The run's stop is its fiber's interruption: the end commits, and the
  // interruption stays the exit.
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
    return yield* Effect.failCause(exit.cause);
  if (parentRunId === null && thrown !== undefined && error !== undefined)
    // A root run's failure. Once its `run.end` row committed, the
    // session's presenter shows that row (`presentTerminalResult`); a run
    // that never opened has no row, so its launch's caller presents this.
    return yield* new AgentError({
      message: error.message,
      cause: thrown,
      ...(error.kind === 'model' ? { failure } : {}),
    });
}, Effect.uninterruptible);
