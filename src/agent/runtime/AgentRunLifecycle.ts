import { Cause, Deferred, Effect } from 'effect';

import { logSdkError, type ResultEvent, type StageHandle } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
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
import {
  buildTerminalFlowResult,
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import { RunArtifactDrainError, type SessionHandle } from './SessionHandle';
import type { AgentLaunchContext } from './AgentLaunchContext';

const logger = createChannelTrace('agentRunLifecycle');

export interface RunFlowLifecycleOptions {
  /** The launching run: the parent edge on the handle; a child may park at WAITING. */
  parentRunId?: RunId;
  /**
   * Workflow-script phase owning this run, stamped on the handle before it is
   * tracked so the parent's very first child roster already groups the row.
   * Deliberately not an `onRun` responsibility: `onRun` fires after `track()`
   * has already notified `RunRegistry.onChildActivity` listeners.
   */
  workflowPhase?: string;
  onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
  /**
   * Fires once with the live per-run handle, right after it is tracked (F-2) —
   * the additive exposure of the control handle (`.trace`, `.result`, interrupt
   * via `executions`). Throwing here must not abort the run, so it is guarded.
   */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
  /**
   * Run-end side effect supplied by the composition layer. The lifecycle owns
   * *when* it fires (terminal completion/failure, and the parked-handle
   * teardown for a later kill) and the guard rails (skipped for WAITING
   * suspensions, logged rather than rethrown), but not *what* it does.
   * Kept injected so this module does not statically reach tool-domain
   * services such as the Lean language adapter.
   */
  onRunEnd?: (runId: RunId) => void | Promise<void>;
}

interface FinalizeRunTerminalParams {
  /**
   * Owns the registry tracking the handle (untracked after the delivery
   * hook), the status machine holding this run's in-memory phase
   * (terminalized last), and the display sidecars drained before the
   * `run.end` row is written — so a waiter that opens the completed-run
   * archive does not race the final transcript or work-plan write, and a
   * drain that failed is the run's terminal outcome rather than a warning
   * behind a COMPLETED row.
   */
  readonly session: SessionHandle;
  /** Live handle for this terminal attempt; its settled flag is the exactly-once guard. */
  readonly handle: RunHandle;
  /**
   * The exiting run's own report. The `run.end` row is the run's terminal
   * fact; the in-memory run phase only supplies stop precedence, so this
   * report stands while that phase is still non-terminal — see
   * {@link finalizeRunTerminal}.
   */
  readonly outcome: RunOutcome;
  /**
   * Classified error facts carried on the `run.end` row, dropped when stop
   * precedence resolves a different outcome than `outcome`.
   */
  readonly error?: ResultEvent['error'];
  /** Run usage totals riding the `run.end` row, when known. */
  readonly usage?: ResultEvent['usage'];
  /**
   * What the flow produced; absent when the run ended before it did. Also
   * absent, by rule rather than omission, on the child-run path
   * (`finalizeChildRun` in `src/tools/delegation/childRun.ts`): a child's
   * product is its per-turn delivery to its parent, not a flow output.
   */
  readonly output?: RunEndOutput;
  /** Transcript stage closed with the resolved outcome (guarded). */
  readonly stage?: Pick<StageHandle, 'end'>;
  /**
   * Delivery hook (subagent onError) run after the result settles and before
   * untrack, so the parent still sees this child as active while the
   * delivery routes. Receives the resolved outcome so the payload the parent
   * gets reports the same terminal fact as the `run.end` row. Guarded: a
   * throwing hook cannot abort finalization.
   */
  readonly deliver?: (outcome: RunOutcome) => void | Promise<void>;
}

interface FinalizeRunTerminalResult {
  readonly event: ResultEvent;
}

/**
 * The single owner of terminal run choreography, shared by the run lifecycle
 * arms below, the agent-CLI session loop, and child runs
 * (`finalizeChildRun`): the transcript stage end, the artifact drain, the
 * `run.end` row (through `finalizeRun`, its one writer), the delivery hook,
 * then registry untrack + terminal run phase — in that order. The row is the
 * post-drain fact: a run whose queued facts rolled back ends FAILED carrying
 * that cause, so a reader that can read the terminal row can trust everything
 * behind it — which is why the stage closes first, as the last fact the run
 * queues, inside the drain that attests it. Exactly-once
 * per handle: the claim below flips synchronously in the same tick as the
 * check, so a second call (e.g. the lifecycle catch arm after the success arm
 * already finalized, or a concurrent finalize racing across this function's
 * await points) no-ops structurally. A stop of a suspended run claims the same
 * gate (`RunHandle.beginSuspendedTermination`), so a kill landing
 * mid-finalize cannot publish a second, contradictory outcome either.
 */
export const finalizeRunTerminal = Effect.fn('finalizeRunTerminal')(function* (
  params: FinalizeRunTerminalParams,
): Effect.fn.Return<FinalizeRunTerminalResult | undefined, Error> {
  const { session, handle } = params;
  if (!handle.claimTerminalFinalize()) return undefined;
  // The handle's stop latch, read once: a stop that landed before the run's
  // exit outranks a child whose process then exits non-zero, on the stage
  // here as on the row below, so no caller cross-checks the latch itself.
  const stopped = handle.stopRequested;
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
        Effect.sync(() => {
          logger.warn('Failed to end parent stage', {
            data: { agentIdentifier: handle.agentName, error: stageErr },
          });
        }),
      ),
    );
  }
  // The `run.end` row is the run's post-drain fact, and this is the drain:
  // settling the ordered publisher for this run, so a failure here rolled
  // back facts the run had queued — the stage closure above included. A
  // terminal row committed after it that still said COMPLETED would tell
  // every later reader — the workflow attempt probe above all — that the run
  // is durably done while its final facts are gone, so the drain decides the
  // outcome rather than being logged past. The run id is what keeps that
  // decision this run's own: a sibling run's rolled-back fact is that run's
  // terminal outcome, never this one's.
  const drainFailure = yield* Effect.tryPromise({
    try: () => session.flushArtifacts(handle.runId),
    catch: (cause) => new RunArtifactDrainError(handle.runId, cause),
  }).pipe(
    Effect.as(undefined),
    Effect.catch((failure) => Effect.succeed(failure)),
  );
  if (drainFailure !== undefined)
    logger.warn('Failed to persist the facts this run queued', {
      data: { runId: handle.runId, error: drainFailure },
    });
  // The exiting run's own report: `params.outcome` unless the drain rolled
  // its facts back, which outranks however the flow itself ended.
  const reported =
    drainFailure === undefined ? params.outcome : RUN_OUTCOME.FAILED;
  // A lost drain is marked as one on the row it decided. The in-process
  // `RunArtifactDrainError` reaches only whoever is awaiting this run, and a
  // one-shot publication failure never reaches even them (the later drains
  // succeed), so the marker is what tells every reader of the row — the
  // in-band caller and the workflow attempt probe above all — that the run's
  // queued facts are gone rather than that the model run failed.
  const reportedError =
    drainFailure === undefined
      ? params.error
      : {
          kind: 'artifact-drain' as const,
          message: toErrorMessage(drainFailure),
        };
  // The `run.end` row written below is the run's terminal fact, and the stop
  // latch read above is not yet spent: the report is only the verdict for a
  // run no stop reached.
  const outcome = stopped ? RUN_OUTCOME.CANCELLED : reported;
  // Error facts the run classified for an outcome that did not happen are not
  // facts about this run.
  const error = outcome === reported ? reportedError : undefined;
  const output = params.output ?? emptyRunEndOutput(handle.category);
  // Write the terminal row BEFORE untrack so the registry's terminal listener
  // event never precedes it. The row carries the classified error `kind`
  // (when any), the run usage totals (present once a round recorded usage,
  // including on failures), and the flow's output.
  const event: ResultEvent = {
    type: 'run.end',
    outcome,
    runId: handle.runId,
    ...(error ? { error } : {}),
    ...(params.usage ? { usage: params.usage } : {}),
    output,
  };
  const finalization = yield* finalizeRun(session, {
    runId: handle.runId,
    outcome,
    error,
    usage: params.usage,
    output,
  });
  if (!finalization.ok) {
    logger.warn('Failed to finalize durable run state', {
      data: {
        agentIdentifier: handle.agentName,
        runId: handle.runId,
        outcomePersisted: finalization.outcomePersisted,
        error: finalization.error,
      },
    });
  }
  if (params.deliver) {
    const deliver = params.deliver;
    yield* Effect.tryPromise({
      try: async () => deliver(outcome),
      catch: ensureError,
    }).pipe(
      Effect.catch((deliveryError) =>
        Effect.sync(() => {
          logger.warn('Terminal delivery hook failed', {
            data: { agentIdentifier: handle.agentName, error: deliveryError },
          });
        }),
      ),
    );
  }
  // The run has produced its canonical terminal result. Guard the cleanup so
  // a throw from untrack's listeners or a run-status host emit cannot
  // escape past an already-settled result.
  yield* Effect.try({
    try: () => {
      session.runs.untrack(handle.runId);
    },
    catch: ensureError,
  }).pipe(
    Effect.catch((cleanupErr) =>
      Effect.sync(() => {
        logger.warn('Post-terminal cleanup threw', {
          data: { agentIdentifier: handle.agentName, error: cleanupErr },
        });
      }),
    ),
  );
  return { event };
});

/** Failures finalizeFailedRun already logged, published, and wrapped; the
 *  outer catch rethrows these untouched instead of finalizing them again. */
const finalizedRunFailures = new WeakSet<Error>();

/**
 * Recover a run's carried failure as an `Error`, so the one failure path below
 * classifies and logs a reported failure exactly as it does an exception that
 * escaped the flow.
 *
 * `RetryErrorInfo` is a `ProviderError` minus the bulky `rawErrorBody`, so it
 * attaches as-is: the missing field stays absent.
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
 * fact — a CANCELLED already recorded by a kill outranks that report, and the
 * `run.end` row carries the verdict. Everything the parent receives — the delivered payload and the returned
 * result — has to carry that same verdict, or an orchestrator formats a failure
 * for a run whose durable record says cancelled.
 */
function withResolvedOutcome(
  result: AgentFlowResult,
  outcome: RunOutcome,
): AgentFlowResult {
  if (result.outcome === outcome) return result;
  return { ...result, outcome };
}

/** Close a suspended run's stage through its session after its trace detached. */
const closeSuspendedTranscriptGroup = Effect.fn(function* (
  session: SessionHandle,
  runId: RunId,
  parentStageId: string | undefined,
): Effect.fn.Return<void, Error> {
  if (!parentStageId) return;
  session.publishRunEvent(runId, {
    type: 'stage.end',
    id: parentStageId,
    status: RUN_OUTCOME.CANCELLED,
  });
  yield* Effect.tryPromise({
    try: () => session.settlePublications(),
    catch: ensureError,
  });
});

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
    runner: (
      handle: RunHandle,
    ) => Effect.Effect<AgentRuntimeFlowResult, Error, R>,
    options?: RunFlowLifecycleOptions,
  ): Effect.fn.Return<AgentRuntimeFlowResult, Error, R | AppState> {
    const { runId, session } = ctx.runScope;
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
    // Roster display fields must be on the handle BEFORE it is tracked:
    // `track()` notifies `RunRegistry.onChildActivity` listeners
    // synchronously, so anything assigned later (e.g. from `onRun`) misses the
    // parent's first roster snapshot.
    if (options?.workflowPhase) handle.workflowPhase = options.workflowPhase;
    // The host's stop: the run's one stop latch, which the runner races. The
    // requests this run left open close with the fibers waiting on them
    // (`SessionHandle.openRequest`). The run signal is not aborted here: the
    // interruption the latch causes aborts it (below), so the Promise-tier
    // bridge stays downstream of the stop rather than beside it.
    const runInterruptHandler = {
      interrupt(): void {
        ctx.interrupt();
      },
    };
    const detachRunInterrupt =
      handle.attachInterruptHandler(runInterruptHandler);
    session.runs.track(handle);
    // A lease record removed out from under this run is not watched: the next
    // fenced write throws `RunLeaseLostError` and the run aborts dirty.
    let suspended = false;
    // Expose the live handle to the launcher (F-2). Guarded: neither a synchronous
    // throw nor an async rejection from a consumer callback may abort the run.
    if (options?.onRun) {
      const onRun = options.onRun;
      // Start observation at the same time as invocation. The callback may
      // run as long as the run does, so its observer must not hold up the
      // flow.
      yield* Effect.tryPromise({
        try: async () => onRun(handle),
        catch: ensureError,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.warn('onRun callback failed', {
              data: { agentIdentifier, error },
            });
          }),
        ),
        Effect.forkDetach({ startImmediately: true }),
      );
    }
    // Shared parameterization of the terminal finalizer for both arms below;
    // outcome, error facts, and the delivery hook are the only per-arm inputs.
    const finalizeTerminal = (arm: {
      outcome: RunOutcome;
      error?: ResultEvent['error'];
      output?: RunEndOutput;
      deliver?: (outcome: RunOutcome) => void | Promise<void>;
    }) =>
      finalizeRunTerminal({
        session,
        handle,
        usage: ctx.usageMonitor.lastTotals(),
        stage: ctx.parentStage,
        ...arm,
      });
    /**
     * The single owner of provider/runtime failure exits, entered from both arms
     * below: a flow carrying structured error metadata and an exception that
     * escaped the runner. Outcome-only domain failures bypass classification and
     * finalize through the ordinary terminal-result path without a fabricated
     * RetryErrorInfo.
     */
    const finalizeFailedRun = Effect.fn(function* (
      err: unknown,
      carried: AgentFlowResult | undefined,
    ) {
      const kind = classifyAgentError(err);
      const outcome = AGENT_ERROR_OUTCOME[kind];
      // normalizeProviderError recovers the structured shape the flow attached
      // (T2-2) when there was one, or formats a fresh one otherwise.
      // toRetryErrorInfo strips rawErrorBody, the `run.end` error type omits
      // it (bulky, not worth persisting) and a bare object spread would silently
      // smuggle it through past the type check.
      const { message: sdkMsg, ...providerErrorInfo } = toRetryErrorInfo(
        normalizeProviderError(err),
      );
      const errorMsg = `Error executing agent ${agentIdentifier}: ${sdkMsg}`;

      // Root-agent failures are surfaced in the stream log. Subagent failures
      // are delivered to the orchestrator below, so avoid adding a second
      // wrapper error that makes a child failure look like the parent failed.
      if (kind !== 'abort' && !handle.isChild) {
        logSdkError(ctx.logger, errorMsg, err, {
          operation: `execute ${agentIdentifier}`,
        });
      }

      const message = kind === 'unexpected' ? errorMsg : sdkMsg;
      // `abort`/`disk-full` route through `formatProviderHttpError`'s
      // `terminalError()` branch, which never populates the provider/
      // credential fields, narrow to the fields it actually sets so
      // the `run.end` error's per-kind union stays honest (see runRecords.ts).
      // Abort still carries the SDK message for event consumers; the toast
      // mapper intentionally suppresses user-facing notifications for aborts.
      const error: NonNullable<ResultEvent['error']> =
        kind === 'abort' || kind === 'disk-full'
          ? {
              kind,
              message,
              userRetryable: providerErrorInfo.userRetryable,
              partialText: providerErrorInfo.partialText,
            }
          : {
              kind,
              message,
              ...providerErrorInfo,
            };
      const subagentResult = handle.isChild
        ? (carried ??
          buildTerminalFlowResult(
            handle.category,
            outcome,
            runId,
            ctx.attachedMemoryMisses,
          ))
        : undefined;
      // One finalize covers all three exits below (subagent / abort / throw).
      // No-ops entirely when the success arm already finalized, so a
      // post-completion throw cannot double-publish a contradictory result.
      // Terminal-error toasts are not emitted here: hosts present them from the
      // `run.end` row via `session.onResult` + `terminalResultToast` (the
      // single decision point), keeping the run-lifecycle out of host UI.
      const finalized = yield* finalizeTerminal({
        outcome,
        error,
        output: carried?.output,
        deliver:
          subagentResult && options?.onError
            ? (resolved) =>
                options.onError?.(
                  err,
                  withResolvedOutcome(subagentResult, resolved),
                )
            : undefined,
      });
      // The finalizer resolved this run's terminal fact; the exits below report
      // the same one it published. It returns nothing only when the success arm
      // already finalized, and then this arm's report is all this exit knows.
      const resolvedOutcome = finalized?.event.outcome ?? outcome;

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

      const finalizedFailure = new AgentError(errorMsg, { cause: err });
      finalizedRunFailures.add(finalizedFailure);
      return yield* Effect.fail(finalizedFailure);
    });
    /**
     * Invoke the composition-supplied run-end hook when the run genuinely ends.
     * The lifecycle owns the guard rails: the WAITING branch invokes it only
     * from the parked-handle teardown if a later kill actually ends the run.
     */
    const runOnRunEnd = Effect.gen(function* () {
      if (!options?.onRunEnd) return;
      const onRunEnd = options.onRunEnd;
      yield* Effect.tryPromise({
        try: async () => onRunEnd(runId),
        catch: ensureError,
      }).pipe(
        Effect.catch((runEndError) =>
          Effect.sync(() => {
            logger.warn('Failed to run the run-end hook', {
              data: { agentIdentifier, runId, error: runEndError },
            });
          }),
        ),
      );
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
      // The lifecycle owns every run-status transition: the start claim here,
      // terminal states in the success/error arms below. Runners must not
      // set run status themselves. Either branch leaves the run carrying
      // this run's own phase, which is what makes the terminal phase a verdict
      // about this run rather than whatever the last one left behind.
      if (Deferred.isDoneUnsafe(ctx.stopped)) {
        // The stop landed before this run had a program to interrupt, so it is
        // recorded on the run signal here: the launch's own Promise-tier work
        // is all there is to cancel.
        ctx.abortRunSignal();
      }
      // The flow is an Effect: a fiber interruption reaches its provider work
      // directly, and its own finalizers settle before the model and trace
      // resources below are disposed. The run signal is aborted from that
      // interruption, so Promise-tier work the flow still retains observes the
      // same stop.
      const result = yield* Effect.suspend(() => runner(handle)).pipe(
        Effect.onInterrupt(() => Effect.sync(() => ctx.abortRunSignal())),
        Effect.ensuring(Effect.sync(detachRunInterrupt)),
      );
      if (isWaitingFlowResult(result)) {
        suspended = true;
        logger.debug(`Task suspended with outcome: ${result.outcome}`);
        // The handle stays tracked (correct for resume) but the live tool-use
        // session and its interrupt handler are already gone by the time
        // this returns (the tool-use loop's scope). Parking the handle is the
        // one place this run is recorded as suspended, and carries the teardown
        // a stop/kill runs instead of the absent interrupt target, see
        // AgentRunLifecycle/RunRegistry issue #7287.
        handle.suspend(
          Effect.gen(function* () {
            session.followUps.terminalize(runId);
            // The run trace has detached; publish its stage close through the session.
            yield* closeSuspendedTranscriptGroup(
              session,
              runId,
              ctx.parentStage.id,
            );
          }).pipe(
            // A parked run killed later ends here. Run-end cleanup remains
            // independent of transcript persistence.
            Effect.ensuring(runOnRunEnd),
          ),
        );
        return result;
      }
      // Provider/runtime failures carry structured error metadata and use the
      // classified failure path. A domain failure may report FAILED without this
      // field and is finalized below as an outcome-only terminal result.
      if (result.error) {
        return yield* finalizeFailedRun(
          toFlowFailureError(result.error),
          result,
        );
      }
      // Persist the terminal fact before any supplementary UX state. In
      // particular, a completed tool-use flow must not remain resumable while an
      // onboarding write is pending.
      const finalized = yield* finalizeTerminal({
        outcome: result.outcome,
        output: result.output,
      });
      // The phase decides the verdict here exactly as in the catch arm: a stop
      // that won on the phase must not let the caller observe COMPLETED.
      const resolvedOutcome = finalized?.event.outcome ?? result.outcome;

      // Onboarding funnel (PRD: agent-native onboarding): State 1 ends when any
      // real run completes. The setup conversation itself doesn't count, but the
      // demo it delegates does (subagent runs land here too). Best-effort: a
      // state write failure must never affect the run.
      if (
        resolvedOutcome === RUN_OUTCOME.COMPLETED &&
        baseAgentName(agentIdentifier) !== SETUP_AGENT_NAME
      ) {
        const globalState = yield* AppState;
        yield* Effect.tryPromise({
          try: async () => {
            if (!getFirstRunDone(globalState)) {
              await setFirstRunDone(globalState, true);
            }
          },
          catch: ensureError,
        }).pipe(Effect.ignore);
      }

      logger.debug(`Task completed with outcome: ${resolvedOutcome}`);
      return withResolvedOutcome(result, resolvedOutcome);
    });
    return yield* run.pipe(
      Effect.catchCause((cause) => {
        const err = ensureError(Cause.squash(cause));
        // A failure already classified and published retains its one error path.
        if (finalizedRunFailures.has(err)) return Effect.fail(err);
        return finalizeFailedRun(err, undefined);
      }),
      Effect.onInterrupt(() =>
        // The Promise flow has joined its actual abort above. Complete the
        // owned terminal result before cleanup while retaining interruption.
        finalizeTerminal({ outcome: RUN_OUTCOME.CANCELLED }).pipe(Effect.orDie),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          detachRunInterrupt();
          // Stop the Lean servers attributed to this run in its worktree(s) so they
          // do not idle until the timeout after the run is gone (CLI/desktop; a host
          // whose Lean integration owns server lifetime no-ops here). Servers still
          // leased by an in-flight request are disposed after their final lease
          // ends. Guarded like the cancel above: a failing stop must not replace the
          // result this run already published. A WAITING suspension is not a run
          // end, so its return skips this and leaves the stop to the suspended-handle
          // teardown if a later kill actually ends the run.
          if (!suspended) {
            yield* runOnRunEnd;
          }
          // Drop the run-trace subscribers (channel sink + transcript recorder) so
          // they don't pile up across many agent runs.
          ctx.disposeTrace();
        }),
      ),
    );
  },
);
