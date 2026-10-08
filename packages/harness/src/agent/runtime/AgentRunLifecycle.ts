import { Cause, Effect, Exit } from 'effect';

import { logSdkError, type ResultEvent, type StageHandle } from '@agent/trace';
import { configChange } from '@agent/storage/runLifecycle';
import {
  AGENT_ERROR_OUTCOME,
  AgentError,
  classifyAgentError,
} from '@common/errors';
import { attachProviderError } from '@common/errors/sdkError/errorMetadata';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import type {
  RetryErrorInfo,
  RunEndOutput,
  RunId,
  RunOutcome,
  SessionEventDraft,
} from '@shared/schemas';
import {
  agentName as baseAgentName,
  emptyRunEndOutput,
  RUN_OUTCOME,
  toRetryErrorInfo,
} from '@shared/schemas';
import {
  getFirstRunDone,
  setFirstRunDone,
} from '@shared/state/onboardingState';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { RunHandle } from './RunHandle';
import { Runs, type AgentRunServices } from './runRegistry';
import { receiveTerminalFailure } from './terminalResultToast';
import { buildTerminalRunEndResult, type RunEndResult } from './RunEndResult';
import type { SessionHandle } from './SessionHandle';
import type { AgentLaunchContext } from './AgentLaunchContext';

const CHANNEL = 'agentRunLifecycle';

/** A lifecycle diagnostic: guarded cleanup logs past its failure here. */
const logLifecycleWarning = (message: string, data: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data }),
    withLogChannel(CHANNEL),
  );

type Settlement = Effect.Effect<readonly SessionEventDraft[]>;

export interface RunLifecycleOptions {
  /** The launching run: the parent edge on the live handle. */
  parentRunId?: RunId;
  /** Fires once with the run's id, right after its handle is tracked (F-2),
   *  forked detached: nothing it does may abort the run, and it is logged. */
  onRun?: (runId: RunId) => Effect.Effect<void, Error>;
  /** A child's last-turn settlement, from the result its run ends with. */
  settleEnd?: (result: RunEndResult) => Settlement;
}

interface FinalizeRunTerminalParams {
  /** Owns the registry tracking the handle (untracked after the `run.end`
   *  row) and the publisher every row of the run goes through in order. */
  readonly session: SessionHandle;
  /** Live handle of the run this terminal ends. */
  readonly handle: RunHandle;
  /**
   * The exiting run's own report. The `run.end` row is the run's terminal
   * fact; the run phase only supplies stop precedence, so this report stands
   * while that phase is still non-terminal — see {@link finalizeRunTerminal}.
   */
  readonly outcome: RunOutcome;
  /** Classified error facts on the `run.end` row, dropped when stop
   *  precedence resolves another outcome than `outcome`. */
  readonly error?: ResultEvent['error'];
  /** What the flow produced; absent when the run ended first, and on the
   *  child-run path, whose product is its per-turn delivery. */
  readonly output?: RunEndOutput;
  /** Transcript stage closed with the resolved outcome (guarded). */
  readonly stage?: Pick<StageHandle, 'end'>;
  /** A child's last-turn settlement under the resolved outcome: its rows
   *  commit with the `run.end` row (`childSettlement.ts`). */
  readonly settle?: (outcome: RunOutcome) => Settlement;
  /**
   * Stop precedence: a stop that reached the run before this finalizer —
   * `Cause.hasInterrupts` on the cause that brought the run here, or the
   * child loop's own interrupted signal — outranks the run's own report, so
   * the stage and the `run.end` row say cancelled.
   */
  readonly stopped?: boolean;
}

interface FinalizeRunTerminalResult {
  readonly event: ResultEvent;
  /** The `run.end` row write's failure: the terminal still settled and
   *  untracked, and the event reports FAILED with its reason. */
  readonly persistFailure?: unknown;
}

/**
 * The single owner of terminal run choreography, shared by the run lifecycle
 * below and agent-CLI child runs (`finalizeChildRun`), in this order: the
 * transcript stage end, the `run.end` row (through `finalizeRun`, its one
 * writer), then registry untrack. The publisher commits in order, so every
 * row the run published lands before its end, and a refusal of one of them
 * is the end's own write failure. Each run has one caller of this: the
 * lifecycle's masked terminal, or the child loop's exit for a run with no
 * lifecycle.
 */
export const finalizeRunTerminal = Effect.fn('finalizeRunTerminal')(
  function* (
    params: FinalizeRunTerminalParams,
  ): Effect.fn.Return<FinalizeRunTerminalResult, Error, Runs> {
    const { session, handle } = params;
    const runs = yield* Runs;
    // Stop precedence, read once: a stop that reached the run before its exit
    // outranks the flow's report, on the stage here as on the row below.
    const stopped = params.stopped === true;
    // Close the transcript stage first: its `stage.end` is published ahead of
    // the `run.end` row, and a refusal of it is that row's write failure.
    if (params.stage) {
      const stage = params.stage;
      const stageOutcome = stopped ? RUN_OUTCOME.CANCELLED : params.outcome;
      yield* Effect.try({
        try: () => stage.end(stageOutcome),
        catch: ensureError,
      }).pipe(
        Effect.catch((stageErr) =>
          logLifecycleWarning('Failed to end parent stage', {
            agentIdentifier: handle.agentName,
            error: stageErr,
          }),
        ),
      );
    }
    // A trace row the store refused means the run's record is incomplete:
    // the run failed, whatever it reported, and its row says why.
    const lost = yield* session.trace.lost(handle.runId);
    const reported = lost === undefined ? params.outcome : RUN_OUTCOME.FAILED;
    // The `run.end` row written below is the run's terminal fact: the report
    // is only the verdict for a run no stop reached.
    const outcome = stopped ? RUN_OUTCOME.CANCELLED : reported;
    const error =
      lost ?? (outcome === params.outcome ? params.error : undefined);
    const output = params.output ?? emptyRunEndOutput();
    // Write the terminal row BEFORE untrack, so the registry's terminal event
    // never precedes it; `finalizeRun` adds the usage totals from history.
    const event: ResultEvent = {
      type: 'run.end',
      outcome,
      runId: handle.runId,
      ...(error ? { error } : {}),
      output,
    };
    const settlement = params.settle ? yield* params.settle(outcome) : [];
    const finalization = yield* session.runs.end({
      runId: handle.runId,
      outcome,
      error,
      output,
      ...(settlement.length > 0 ? { settlement } : {}),
    });
    if (!finalization.ok)
      yield* logLifecycleWarning('Failed to finalize durable run state', {
        agentIdentifier: handle.agentName,
        runId: handle.runId,
        error: finalization.error,
      });
    // Guard the cleanup: a throw from untrack's listeners must not escape
    // past a settled result. Only this handle's registration goes; a run
    // that started again is its successor's.
    yield* Effect.try({
      try: () => runs.untrackIfCurrent(handle),
      catch: ensureError,
    }).pipe(
      Effect.catch((cleanupErr) =>
        logLifecycleWarning('Post-terminal cleanup threw', {
          agentIdentifier: handle.agentName,
          error: cleanupErr,
        }),
      ),
    );
    if (finalization.ok) return { event };
    // A run whose `run.end` did not commit failed, whatever it reported.
    const unsaved = ensureError(finalization.error);
    const message = `The run's end could not be saved: ${unsaved.message}`;
    const failed = { kind: classifyAgentError(unsaved), message };
    return {
      event: { ...event, outcome: RUN_OUTCOME.FAILED, error: failed },
      persistFailure: finalization.error,
    };
  },
  // The run's terminal is atomic: the run's stop is its fiber's interruption,
  // and one landing mid-way must not strand the run with no `run.end` row.
  // A stop lands either before this finalizer or after its row, never inside.
  Effect.uninterruptible,
);

/**
 * Recover a run's carried failure as an `Error`, so the one failure path below
 * classifies and logs a reported failure exactly as it does an exception that
 * escaped the flow. `RetryErrorInfo` is a `ProviderError` minus the bulky
 * `rawErrorBody`, so it attaches as-is: its classification is what the
 * classifier reads.
 */
function toRunFailureError(error: RetryErrorInfo): Error {
  const failure = new Error(error.message);
  attachProviderError(failure, error);
  return failure;
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
  result: RunEndResult,
  outcome: RunOutcome,
): RunEndResult {
  if (result.outcome === outcome) return result;
  return { ...result, outcome };
}

/**
 * Wraps a flow runner with full agent run lifecycle management: run
 * registry tracking, run-status transitions, error classification, user
 * notifications, and resource disposal.
 *
 * Separating this from `executeAgent` keeps the orchestrator focused on flow
 * routing while this module owns the invariants that must hold across every
 * agent run (registration, status accounting, error surfacing, cleanup).
 */
export const runWithLifecycle = Effect.fn('runWithLifecycle')(function* <R>(
  ctx: AgentLaunchContext,
  runner: (handle: RunHandle) => Effect.Effect<RunEndResult, Error, R>,
  options?: RunLifecycleOptions,
): Effect.fn.Return<RunEndResult, Error, R | AppState | AgentRunServices> {
  const { runId, session } = ctx;
  const runs = yield* Runs;
  const agentIdentifier = ctx.config.agent;
  const script = ctx.config.script ?? null;
  const handle = new RunHandle(
    {
      runId,
      // The identity its launch registered: a background script's run is
      // the parent's agent making one call; a recipe's is its agent's.
      identity:
        script?.kind === 'background'
          ? { kind: 'script', title: script.title }
          : { kind: 'agent', agent: agentIdentifier },
    },
    options?.parentRunId ?? null,
    ctx.logger,
  );
  const settleEnd = options?.settleEnd;
  // The terminal finalizer; outcome and error facts vary per exit, and a
  // child's last turn (`settledBy`) settles under the resolved outcome.
  const finalizeTerminal = ({
    settledBy,
    ...arm
  }: {
    outcome: RunOutcome;
    error?: ResultEvent['error'];
    output?: RunEndOutput;
    stopped?: boolean;
    settledBy?: RunEndResult;
  }) =>
    finalizeRunTerminal({
      session,
      handle,
      stage: ctx.parentStage,
      ...arm,
      ...(settledBy && settleEnd
        ? { settle: (o) => settleEnd(withResolvedOutcome(settledBy, o)) }
        : {}),
    });
  /**
   * The single owner of provider/runtime failure exits: a flow carrying
   * structured error metadata, or an exception that escaped the runner.
   */
  const finalizeFailedRun = Effect.fn(function* (
    err: unknown,
    carried: RunEndResult | undefined,
    stopped = false,
  ) {
    // A throw in this fallible prologue must not strand the tracked handle
    // without its terminal: it falls back to an unexpected failure.
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
        if (kind !== 'abort' && handle.parent === null) {
          yield* logSdkError(ctx.logger, errorMsg, err, {
            operation: `execute ${agentIdentifier}`,
          });
        }
        const message = kind === 'unexpected' ? errorMsg : sdkMsg;
        // `abort`/`disk-full` never carry provider or credential fields
        // (`terminalError()`): narrow them so runRecords' union stays honest.
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
    // A stop that reached the run outranks the failure beside it; the
    // failure still rides the cancelled row as its error detail.
    const outcome = stopped ? RUN_OUTCOME.CANCELLED : AGENT_ERROR_OUTCOME[kind];
    // A child's failure rides its result: the normalized error its
    // delivery to the parent reports.
    const subagentResult: RunEndResult | undefined = handle.parent
      ? {
          ...(carried ??
            buildTerminalRunEndResult(
              outcome,
              runId,
              ctx.attachedMemoryMisses,
            )),
          error: info,
        }
      : undefined;
    // One finalize covers the three exits below; its row is the toast's.
    const finalized = yield* finalizeTerminal({
      outcome,
      error,
      output: carried?.output,
      stopped,
      settledBy: subagentResult,
    });
    // The exits below report the terminal fact the finalizer published.
    const resolvedOutcome = finalized.event.outcome;
    if (subagentResult) {
      return withResolvedOutcome(subagentResult, resolvedOutcome);
    }
    if (kind === 'abort') {
      return buildTerminalRunEndResult(
        resolvedOutcome,
        runId,
        ctx.attachedMemoryMisses,
      );
    }

    const failure = new AgentError(errorMsg, { cause: err });
    receiveTerminalFailure(failure, finalized);
    return yield* Effect.fail(failure);
  });
  const run = Effect.gen(function* () {
    // `run.start` is already out: the launch context published it at its
    // reservation commit point, with the run's configuration. An
    // activation writes it again only when it changed (a resume on
    // another model), before the RUNNING transition so the fold already
    // carries it when the transition-owned run-start side effects fire.
    const config = yield* configChange(ctx.session, runId, ctx.config);
    if (config !== null) yield* ctx.session.log.transact([config]);
    // The flow is an Effect: a fiber interruption reaches its provider work
    // directly, and its finalizers settle before the resources below are
    // disposed.
    return yield* Effect.suspend(() => runner(handle));
  });
  /**
   * The run's one terminal writer: every way the flow exits — a result, a
   * reported failure, an escaped exception, a stop — reaches this verdict
   * exactly once, since it is the exit of one masked region rather than an
   * arm per exit. Provider/runtime failures carry structured error metadata
   * and take the classified failure path; a domain failure may report
   * FAILED without it and finalizes as an outcome-only terminal result.
   */
  const terminal = (
    exit: Exit.Exit<RunEndResult, Error>,
  ): Effect.Effect<RunEndResult, Error, Runs> => {
    if (Exit.isSuccess(exit)) {
      const result = exit.value;
      if (result.error) {
        return finalizeFailedRun(toRunFailureError(result.error), result);
      }
      // The phase decides the verdict here exactly as on a failure: a stop
      // that won on the phase must not let the caller observe COMPLETED.
      return finalizeTerminal({
        outcome: result.outcome,
        output: result.output,
        settledBy: result,
      }).pipe(
        // An end that did not save fails the run, saying why.
        Effect.flatMap(({ event, persistFailure }) =>
          persistFailure === undefined
            ? Effect.succeed(withResolvedOutcome(result, event.outcome))
            : Effect.fail(
                new AgentError(event.error?.message ?? '', {
                  cause: persistFailure,
                }),
              ),
        ),
      );
    }
    const cause = exit.cause;
    // The run's stop is its fiber's interruption, and this is its verdict:
    // the terminal result completes before cleanup, and the interruption
    // stays the exit. An interruption the program raised on itself (a
    // prompt closed under it) is a stop too, not a failure: squashed, it
    // would record "All fibers interrupted without error" as FAILED.
    if (Cause.hasInterruptsOnly(cause)) {
      return finalizeTerminal({
        outcome: RUN_OUTCOME.CANCELLED,
        stopped: true,
      }).pipe(Effect.orDie, Effect.andThen(Effect.failCause(cause)));
    }
    const err = ensureError(Cause.squash(cause));
    if (!Cause.hasInterrupts(cause)) return finalizeFailedRun(err, undefined);
    // A stop that met a failure (a finalizer that died or failed as the
    // stop unwound it) is still a stop, as `failureOutcome` keys it: the row
    // says CANCELLED and carries the failure, which is logged, not lost.
    return logLifecycleWarning('A stopped run also failed', {
      runId,
      error: err,
    }).pipe(Effect.andThen(finalizeFailedRun(err, undefined, true)));
  };
  // The handle is tracked only inside the region whose exit is the
  // terminal above, so no stop lands between the two: a tracked handle is
  // always finalized. The host's stop is this run fiber's interruption
  // (`RunRegistry.interrupt`); the requests this run left open close with
  // the fibers waiting on them (`SessionRequests.ask`).
  const resolved = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      runs.track(handle);
      // A claim moved out from under this run is not watched: the next
      // append refuses with `DatabaseNotOwner` and the run aborts dirty.
      // Expose the live handle to the launcher (F-2). Guarded: neither a
      // synchronous throw nor an async rejection from a consumer callback
      // may abort the run.
      if (options?.onRun) {
        const onRun = options.onRun;
        // Start observation at the same time as invocation. The callback
        // may run as long as the run does, so its observer must not hold
        // up the flow.
        yield* Effect.suspend(() => onRun(handle.runId)).pipe(
          Effect.catchCause((cause) =>
            logLifecycleWarning('onRun callback failed', {
              agentIdentifier,
              error: Cause.squash(cause),
            }),
          ),
          Effect.forkDetach({ startImmediately: true }),
        );
      }
      return yield* terminal(yield* Effect.exit(restore(run)));
    }),
  );

  // Onboarding funnel (PRD: agent-native onboarding): State 1 ends when any
  // real run completes. The setup conversation itself doesn't count, but the
  // demo it delegates does (subagent runs land here too). Best-effort: a
  // state write failure must never affect the run, whose terminal fact is
  // already persisted.
  if (
    resolved.outcome === RUN_OUTCOME.COMPLETED &&
    baseAgentName(agentIdentifier) !== SETUP_AGENT_NAME
  ) {
    const globalState = yield* AppState;
    // Best-effort by contract: the flag is a funnel input, so a refused
    // write is logged and the run still completes.
    yield* getFirstRunDone(globalState).pipe(
      Effect.flatMap((done) =>
        done ? Effect.void : setFirstRunDone(globalState, true),
      ),
      Effect.catch((error) =>
        logLifecycleWarning('Failed to record the first completed run', error),
      ),
    );
  }

  yield* Effect.logDebug(
    `Task completed with outcome: ${resolved.outcome}`,
  ).pipe(withLogChannel(CHANNEL));
  return resolved;
});
