import { Cause, Effect, Exit } from 'effect';

import { logSdkError, type ResultEvent, type StageHandle } from '@agent/trace';
import { finalizeRun } from '@agent/storage/runLifecycle';
import {
  AGENT_ERROR_OUTCOME,
  AgentError,
  classifyAgentError,
} from '@common/errors';
import {
  attachContextWindowError,
  attachMissingApiKeyError,
  attachProviderError,
} from '@common/errors/sdkError/errorMetadata';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import type {
  RetryErrorInfo,
  RunEndOutput,
  RunId,
  RunOutcome,
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
import { RunHandle, type AgentRunHandle } from './RunHandle';
import { Runs } from './runRegistry';
import {
  buildTerminalFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import { RunArtifactDrainError, type SessionHandle } from './SessionHandle';
import type { AgentLaunchContext } from './AgentLaunchContext';
import type { AgentRunServices } from './runRegistry';

const CHANNEL = 'agentRunLifecycle';

/** A lifecycle diagnostic: guarded cleanup logs past its failure here. */
const logLifecycleWarning = (message: string, data: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data }),
    withLogChannel(CHANNEL),
  );

export interface RunFlowLifecycleOptions {
  /** The launching run: the parent edge on the live handle. */
  parentRunId?: RunId;
  /**
   * Reported to the delegation chain through the terminal `deliver` hook, so
   * it carries that hook's synchronous contract.
   */
  onError?: (error: unknown, result: AgentFlowResult) => void;
  /**
   * Fires once with the live per-run handle, right after it is tracked (F-2).
   * Neither a failure of this program nor a throw while building it may abort
   * the run, so the run forks it detached and logs whatever it ends on.
   */
  onRun?: (handle: AgentRunHandle) => Effect.Effect<void, Error>;
}

interface FinalizeRunTerminalParams {
  /**
   * Owns the registry tracking the handle (untracked after the delivery hook)
   * and the display sidecars drained before the `run.end` row is written, so
   * a waiter that opens the completed-run archive does not race the final
   * transcript write and a failed drain is the run's terminal outcome rather
   * than a warning behind a COMPLETED row.
   */
  readonly session: SessionHandle;
  /** Live handle of the run this terminal ends. */
  readonly handle: RunHandle;
  /**
   * The exiting run's own report. The `run.end` row is the run's terminal
   * fact; the run phase only supplies stop precedence, so this report stands
   * while that phase is still non-terminal — see {@link finalizeRunTerminal}.
   */
  readonly outcome: RunOutcome;
  /**
   * Classified error facts carried on the `run.end` row, dropped when stop
   * precedence resolves a different outcome than `outcome`.
   */
  readonly error?: ResultEvent['error'];
  /**
   * What the flow produced; absent when the run ended before it did, and
   * absent by rule on the child-run path (`finalizeChildRun`): a child's
   * product is its per-turn delivery to its parent, not a flow output.
   */
  readonly output?: RunEndOutput;
  /** Transcript stage closed with the resolved outcome (guarded). */
  readonly stage?: Pick<StageHandle, 'end'>;
  /**
   * Delivery hook (subagent onError) run after the result settles and before
   * untrack, so the parent still sees this child as active while the delivery
   * routes. Receives the resolved outcome, so the parent's payload reports the
   * same terminal fact as the `run.end` row. Synchronous by contract and
   * guarded by `Effect.try`: a throwing hook cannot abort finalization.
   */
  readonly deliver?: (outcome: RunOutcome) => void;
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
  /** The `run.end` row write's failure, when it failed — a report on the
   *  result, not a thrown fact: the terminal still drained, settled and
   *  untracked.
   *  Callers whose own exit must attest the persistence (the child loop's
   *  cleanup aggregation) read it here. */
  readonly persistFailure?: unknown;
}

/**
 * The single owner of terminal run choreography, shared by the run lifecycle
 * below and agent-CLI child runs (`finalizeChildRun`): the transcript stage
 * end, the artifact drain, the `run.end` row (through `finalizeRun`, its one
 * writer), the delivery hook, then registry untrack + terminal run phase — in
 * that order. The row is the post-drain fact, so a reader that can read it
 * can trust everything behind it; that is why the stage closes first, as the
 * last fact the run queues, inside the drain that attests it. Each run has
 * exactly one caller of this, by structure: the lifecycle's one masked
 * terminal, or the child loop's exit for a run with no lifecycle.
 */
export const finalizeRunTerminal = Effect.fn('finalizeRunTerminal')(
  (
    params: FinalizeRunTerminalParams,
  ): Effect.Effect<FinalizeRunTerminalResult, Error, Runs> =>
    // The run's terminal is atomic: the run's stop is its fiber's
    // interruption, and one landing mid-drain must not strand the run with
    // no `run.end` row. A stop then lands either before this finalizer or
    // after its row, never inside it.
    Effect.uninterruptible(finalizeRunTerminalBody(params)),
);
const finalizeRunTerminalBody = Effect.fn('finalizeRunTerminal.body')(
  function* (
    params: FinalizeRunTerminalParams,
  ): Effect.fn.Return<FinalizeRunTerminalResult, Error, Runs> {
    const { session, handle } = params;
    const runs = yield* Runs;
    // Stop precedence, read once: a stop that reached the run before its own
    // exit outranks the report the flow makes of that exit, on the stage here
    // as on the row below, so no caller cross-checks the stop itself.
    const stopped = params.stopped === true;
    // Close the transcript stage before the drain, not after it: `stage.end`
    // queues one more publication, and a terminal row that called itself the
    // post-drain fact while the run's last queued fact was still unsettled
    // would say COMPLETED over a transcript closure that rolled back. What the
    // stage carries is the run's own report, since the drain's verdict is not
    // knowable until the publication this queues has settled; the `run.end` row
    // is where that verdict lands.
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
    // The `run.end` row is the run's post-drain fact, and this is the drain:
    // settling the ordered publisher for this run, so a failure here rolled
    // back facts the run had queued — the stage closure above included — and
    // decides the outcome rather than being logged past. The run id keeps that
    // decision this run's own: a sibling's rolled-back fact is that run's.
    const drainFailure = yield* session.settlePublications(handle.runId).pipe(
      Effect.mapError(
        (cause) => new RunArtifactDrainError(handle.runId, cause),
      ),
      Effect.as(undefined),
      Effect.catch((failure) => Effect.succeed(failure)),
    );
    if (drainFailure !== undefined)
      yield* logLifecycleWarning(
        'Failed to persist the facts this run queued',
        {
          runId: handle.runId,
          error: drainFailure,
        },
      );
    // The exiting run's own report: `params.outcome` unless the drain rolled
    // its facts back, which outranks however the flow itself ended.
    const reported =
      drainFailure === undefined ? params.outcome : RUN_OUTCOME.FAILED;
    // A lost drain is marked as one on the row it decided: the in-process
    // `RunArtifactDrainError` reaches only whoever awaits this run, so the
    // marker is what tells every reader of the row that the run's queued facts
    // are gone rather than that the model run failed.
    const reportedError =
      drainFailure === undefined
        ? params.error
        : {
            kind: 'artifact-drain' as const,
            message: toErrorMessage(drainFailure),
          };
    // The `run.end` row written below is the run's terminal fact: the report
    // is only the verdict for a run no stop reached.
    const outcome = stopped ? RUN_OUTCOME.CANCELLED : reported;
    // Error facts the run classified for an outcome that did not happen are not
    // facts about this run. A lost drain is the exception: the queued facts are
    // gone whichever outcome the row carries, so the marker rides a cancelled
    // row too and its readers still see an attempt nothing may repeat.
    const error =
      drainFailure !== undefined || outcome === reported
        ? reportedError
        : undefined;
    const output = params.output ?? emptyRunEndOutput(handle.category);
    // Write the terminal row BEFORE untrack so the registry's terminal listener
    // event never precedes it. The row carries the classified error `kind`
    // (when any) and the flow's output; `finalizeRun` adds the usage totals
    // from the run's ledger, their one authority.
    const event: ResultEvent = {
      type: 'run.end',
      outcome,
      runId: handle.runId,
      ...(error ? { error } : {}),
      output,
    };
    const finalization = yield* finalizeRun(session, {
      runId: handle.runId,
      outcome,
      error,
      output,
    });
    if (!finalization.ok) {
      yield* logLifecycleWarning('Failed to finalize durable run state', {
        agentIdentifier: handle.agentName,
        runId: handle.runId,
        outcomePersisted: finalization.outcomePersisted,
        error: finalization.error,
      });
    }
    if (params.deliver) {
      const deliver = params.deliver;
      yield* Effect.try({
        try: () => deliver(outcome),
        catch: ensureError,
      }).pipe(
        Effect.catch((deliveryError) =>
          logLifecycleWarning('Terminal delivery hook failed', {
            agentIdentifier: handle.agentName,
            error: deliveryError,
          }),
        ),
      );
    }
    // The run has produced its canonical terminal result. Guard the cleanup so
    // a throw from untrack's listeners or a run-status host emit cannot
    // escape past an already-settled result.
    yield* Effect.try({
      try: () => {
        // Only this handle's registration: a run that started again is the
        // successor's, and a late terminal of the generation it replaced must
        // not untrack it.
        runs.untrackIfCurrent(handle);
      },
      catch: ensureError,
    }).pipe(
      Effect.catch((cleanupErr) =>
        logLifecycleWarning('Post-terminal cleanup threw', {
          agentIdentifier: handle.agentName,
          error: cleanupErr,
        }),
      ),
    );
    return {
      event,
      ...(finalization.ok ? {} : { persistFailure: finalization.error }),
    };
  },
);

/**
 * Recover a run's carried failure as an `Error`, so the one failure path below
 * classifies and logs a reported failure exactly as it does an exception that
 * escaped the flow. `RetryErrorInfo` is a `ProviderError` minus the bulky
 * `rawErrorBody`, so it attaches as-is: the missing field stays absent.
 */
function toFlowFailureError(error: RetryErrorInfo): Error {
  const failure = new Error(error.message);
  attachProviderError(failure, error);
  // Restore the typed runtime marker selected by the canonical persisted
  // classification. Exhaustion kinds need no Error marker: their actionable
  // route remains on the attached ProviderError.
  const classificationKind = error.classification?.kind;
  switch (classificationKind) {
    case 'missing-api-key':
      attachMissingApiKeyError(failure);
      break;
    case 'context-window':
      attachContextWindowError(failure);
      break;
    case 'upstream-credit':
    case 'chatgpt-subscription':
    case 'copilot-subscription':
    case 'kimi-code-subscription':
    case 'glm-coding-plan':
    case 'xai-subscription':
    case undefined:
      break;
    default:
      classificationKind satisfies never;
  }
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
  result: AgentFlowResult,
  outcome: RunOutcome,
): AgentFlowResult {
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
export const runFlowWithLifecycle = Effect.fn('runFlowWithLifecycle')(
  function* <R>(
    ctx: AgentLaunchContext,
    runner: (handle: RunHandle) => Effect.Effect<AgentFlowResult, Error, R>,
    options?: RunFlowLifecycleOptions,
  ): Effect.fn.Return<AgentFlowResult, Error, R | AppState | AgentRunServices> {
    const { runId, session } = ctx;
    const runs = yield* Runs;
    const agentIdentifier = ctx.config.agent;
    const handle = new RunHandle(
      {
        runId,
        identity: { kind: 'agent', agent: agentIdentifier },
        category: ctx.setting.agentCategory,
      },
      options?.parentRunId ?? null,
      ctx.logger,
    );
    // The terminal finalizer; outcome, error facts and delivery vary per exit.
    const finalizeTerminal = (arm: {
      outcome: RunOutcome;
      error?: ResultEvent['error'];
      output?: RunEndOutput;
      deliver?: (outcome: RunOutcome) => void;
      stopped?: boolean;
    }) =>
      finalizeRunTerminal({
        session,
        handle,
        stage: ctx.parentStage,
        ...arm,
      });
    /**
     * The single owner of provider/runtime failure exits: a flow carrying
     * structured error metadata, or an exception that escaped the runner.
     */
    const finalizeFailedRun = Effect.fn(function* (
      err: unknown,
      carried: AgentFlowResult | undefined,
      stopped = false,
    ) {
      // A throw in this fallible prologue must not strand the tracked handle
      // without its terminal: it falls back to an unexpected failure.
      const prologue = yield* Effect.exit(
        Effect.sync(() => {
          const kind = classifyAgentError(err);
          // toRetryErrorInfo strips rawErrorBody, which the `run.end` error
          // type omits and a bare object spread would smuggle past the check.
          const { message: sdkMsg, ...providerErrorInfo } = toRetryErrorInfo(
            normalizeProviderError(err),
          );
          const errorMsg = `Error executing agent ${agentIdentifier}: ${sdkMsg}`;
          // Root failures are logged here; a subagent's is delivered to its
          // orchestrator, so a second wrapper error would blame the parent.
          if (kind !== 'abort' && !handle.isChild) {
            logSdkError(ctx.logger, errorMsg, err, {
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
          return { kind, errorMsg, error };
        }),
      );
      const fallbackMsg = `Error executing agent ${agentIdentifier}: ${toErrorMessage(err)}`;
      const { kind, errorMsg, error } = Exit.isSuccess(prologue)
        ? prologue.value
        : yield* logLifecycleWarning('Run failure prologue failed', {
            runId,
            error: Cause.squash(prologue.cause),
          }).pipe(
            Effect.as({
              kind: 'unexpected' as const,
              errorMsg: fallbackMsg,
              error: { kind: 'unexpected' as const, message: fallbackMsg },
            }),
          );
      // A stop that reached the run outranks the failure beside it; the
      // failure still rides the cancelled row as its error detail.
      const outcome = stopped
        ? RUN_OUTCOME.CANCELLED
        : AGENT_ERROR_OUTCOME[kind];
      const subagentResult = handle.isChild
        ? (carried ??
          buildTerminalFlowResult(
            handle.category,
            outcome,
            runId,
            ctx.attachedMemoryMisses,
          ))
        : undefined;
      // One finalize covers all three exits below (subagent / abort / throw);
      // hosts toast from the `run.end` row (`terminalResultToast`).
      const finalized = yield* finalizeTerminal({
        outcome,
        error,
        output: carried?.output,
        stopped,
        deliver:
          subagentResult && options?.onError
            ? (resolved) =>
                options.onError?.(
                  err,
                  withResolvedOutcome(subagentResult, resolved),
                )
            : undefined,
      });
      // The exits below report the terminal fact the finalizer published.
      const resolvedOutcome = finalized.event.outcome;
      if (subagentResult) {
        return withResolvedOutcome(subagentResult, resolvedOutcome);
      }
      if (kind === 'abort') {
        return buildTerminalFlowResult(
          handle.category,
          resolvedOutcome,
          runId,
          ctx.attachedMemoryMisses,
        );
      }

      return yield* Effect.fail(new AgentError(errorMsg, { cause: err }));
    });
    const run = Effect.gen(function* () {
      // `run.start` is already out: the launch context published it at its
      // reservation commit point. Publish the run config before the RUNNING
      // transition so the fold already carries the run's real category when
      // the transition-owned run-start side effects fire.
      ctx.logger.emit({
        type: 'run.config',
        runId,
        config: ctx.config,
      });
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
      exit: Exit.Exit<AgentFlowResult, Error>,
    ): Effect.Effect<AgentFlowResult, Error, Runs> => {
      if (Exit.isSuccess(exit)) {
        const result = exit.value;
        if (result.error) {
          return finalizeFailedRun(toFlowFailureError(result.error), result);
        }
        // The phase decides the verdict here exactly as on a failure: a stop
        // that won on the phase must not let the caller observe COMPLETED.
        return finalizeTerminal({
          outcome: result.outcome,
          output: result.output,
        }).pipe(
          Effect.map((finalized) =>
            withResolvedOutcome(result, finalized.event.outcome),
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
      // stop unwound it) is still a stop, as `runVerdict` keys it: the row
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
    // the fibers waiting on them (`SessionHandle.openRequest`).
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
          yield* Effect.suspend(() => onRun(handle)).pipe(
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
          logLifecycleWarning(
            'Failed to record the first completed run',
            error,
          ),
        ),
      );
    }

    yield* Effect.logDebug(
      `Task completed with outcome: ${resolved.outcome}`,
    ).pipe(withLogChannel(CHANNEL));
    return resolved;
  },
);
