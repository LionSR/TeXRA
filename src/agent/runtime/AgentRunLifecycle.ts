import { Cause, Effect } from 'effect';

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
import { Runs } from './runRegistry';
import {
  buildTerminalFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import { RunArtifactDrainError, type SessionHandle } from './SessionHandle';
import type { AgentLaunchContext } from './AgentLaunchContext';
import type { AgentRunServices } from './toolInjection';

const logger = createChannelTrace('agentRunLifecycle');

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
  /**
   * Run-end side effect supplied by the composition layer. The lifecycle owns
   * its terminal timing and logs failures without replacing the run result.
   * Kept injected so this module does not statically reach tool-domain
   * services such as the Lean language adapter.
   */
  onRunEnd?: (runId: RunId) => Effect.Effect<void, never, AgentRunServices>;
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
  /** Live handle for this terminal attempt; its settled flag is the exactly-once guard. */
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
  /** Run usage totals riding the `run.end` row, when known. */
  readonly usage?: ResultEvent['usage'];
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
}

/**
 * The single owner of terminal run choreography, shared by the run lifecycle
 * arms below, the agent-CLI session loop, and child runs
 * (`finalizeChildRun`): the transcript stage end, the artifact drain, the
 * `run.end` row (through `finalizeRun`, its one writer), the delivery hook,
 * then registry untrack + terminal run phase — in that order. The row is the
 * post-drain fact, so a reader that can read it can trust everything behind
 * it; that is why the stage closes first, as the last fact the run queues,
 * inside the drain that attests it. Exactly-once per handle: the claim below
 * flips synchronously in the same tick as the check, so a second call cannot
 * win — the catch arm after the success arm finalized, a concurrent finalize
 * racing across an await point, or a stop while the run waits for input.
 */
export const finalizeRunTerminal = Effect.fn('finalizeRunTerminal')(
  (
    params: FinalizeRunTerminalParams,
  ): Effect.Effect<FinalizeRunTerminalResult | undefined, Error, Runs> =>
    // The run's terminal is atomic: the run's stop is its fiber's
    // interruption, and one landing mid-drain must not strand the run with
    // its exactly-once claim spent and no `run.end` row. A stop then lands
    // either before this finalizer or after its row, never inside it.
    Effect.uninterruptible(finalizeRunTerminalBody(params)),
);
const finalizeRunTerminalBody = Effect.fn('finalizeRunTerminal.body')(
  function* (
    params: FinalizeRunTerminalParams,
  ): Effect.fn.Return<FinalizeRunTerminalResult | undefined, Error, Runs> {
    const { session, handle } = params;
    if (!handle.claimTerminalFinalize()) return undefined;
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
      logger.warn('Failed to persist the facts this run queued', {
        data: { runId: handle.runId, error: drainFailure },
      });
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
    // The `run.end` row written below is the run's terminal fact, and the stop
    // latch read above is not yet spent: the report is only the verdict for a
    // run no stop reached.
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
      yield* Effect.try({
        try: () => deliver(outcome),
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
        // Only this handle's registration: a run that started again is the
        // successor's, and a late terminal of the generation it replaced must
        // not untrack it.
        runs.untrackIfCurrent(handle);
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
  },
);

/** Failures finalizeFailedRun already logged, published, and wrapped; the
 *  outer catch rethrows these untouched instead of finalizing them again. */
const finalizedRunFailures = new WeakSet<Error>();

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
    // The host's stop is this run fiber's interruption
    // (`RunRegistry.interrupt`): the exit protocol and the arms below record
    // it. The requests this run left open close with the fibers waiting on
    // them (`SessionHandle.openRequest`).
    runs.track(handle);
    // A claim moved out from under this run is not watched: the next append
    // refuses with `DatabaseNotOwner` and the run aborts dirty.
    // Expose the live handle to the launcher (F-2). Guarded: neither a synchronous
    // throw nor an async rejection from a consumer callback may abort the run.
    if (options?.onRun) {
      const onRun = options.onRun;
      // Start observation at the same time as invocation. The callback may
      // run as long as the run does, so its observer must not hold up the
      // flow.
      yield* Effect.suspend(() => onRun(handle)).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logger.warn('onRun callback failed', {
              data: { agentIdentifier, error: Cause.squash(cause) },
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
      deliver?: (outcome: RunOutcome) => void;
      stopped?: boolean;
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
      // toRetryErrorInfo strips rawErrorBody, which the `run.end` error type
      // omits and a bare object spread would smuggle past the type check.
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
      // `terminalError()` branch, which never populates the provider or
      // credential fields: narrow to the fields it sets so the `run.end`
      // error's per-kind union stays honest (see runRecords.ts). Abort still
      // carries the SDK message for event consumers.
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
      // Terminal-error toasts are the hosts', from the `run.end` row via
      // `session.onResult` + `terminalResultToast`.
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
      // The finalizer resolved this run's terminal fact, and the exits below
      // report the one it published; it returns nothing only when the success
      // arm already finalized.
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
     * Invoke the composition-supplied hook once the live run ends.
     */
    const runOnRunEnd = Effect.gen(function* () {
      if (!options?.onRunEnd) return;
      // Guarded on every cause but interruption: this runs as a finalizer,
      // where a failure or defect would otherwise replace the result this run
      // already published.
      yield* options.onRunEnd(runId).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => {
                logger.warn('Failed to run the run-end hook', {
                  data: { agentIdentifier, runId, error: Cause.squash(cause) },
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
      // terminal states in the success/error arms below, never the runner's.
      // Either branch leaves the run carrying this run's own phase, which is
      // what makes the terminal phase a verdict about this run. The flow is an
      // Effect: a fiber interruption reaches its provider work directly, and
      // its finalizers settle before the resources below are disposed.
      const result = yield* Effect.suspend(() => runner(handle));
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
        // Best-effort by contract: the flag is a funnel input, so a refused
        // write is logged and the run still completes.
        yield* getFirstRunDone(globalState).pipe(
          Effect.flatMap((done) =>
            done ? Effect.void : setFirstRunDone(globalState, true),
          ),
          Effect.catch((error) =>
            Effect.sync(() =>
              logger.warn('Failed to record the first completed run', {
                data: error,
              }),
            ),
          ),
        );
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
        // The run's stop is its fiber's interruption, and this is its
        // verdict: complete the owned terminal result before cleanup while
        // retaining interruption.
        finalizeTerminal({
          outcome: RUN_OUTCOME.CANCELLED,
          stopped: true,
        }).pipe(Effect.orDie),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* runOnRunEnd;
        }),
      ),
    );
  },
);
