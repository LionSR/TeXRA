import { Cause, Effect } from 'effect';

import type { FinalizeExecutionInput } from '@agent/storage';
import {
  logSdkError,
  type AgentTrace,
  type ResultEvent,
  type StageHandle,
} from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  finalizeRun,
  retainFlowRecordUnlessCompleted,
} from '@agent/storage/executionLifecycle';
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
import { platform } from '@platform/platform';
import type {
  ExecutionId,
  RetryErrorInfo,
  RunOutcome,
  StreamTabId,
} from '@shared/schemas';
import {
  agentName as baseAgentName,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  toRetryErrorInfo,
} from '@shared/schemas';
import {
  isTerminalOutcomePhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import {
  getFirstRunDone,
  setFirstRunDone,
} from '@shared/state/onboardingState';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { ensureError } from '@utils/errors/errorMessage';
import { AgentExecutionHandle, type AgentRunHandle } from './ExecutionHandle';
import {
  buildTerminalFlowResult,
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import type { SessionHandle } from './SessionHandle';
import type { ExecutionRegistry } from './executionRegistry';
import type { AgentLaunchContext } from './AgentLaunchContext';
import type { StreamStatusMachine } from './StreamStatusService';

const logger = createChannelTrace('agentRunLifecycle');

export interface RunFlowLifecycleOptions {
  isSubagent?: boolean;
  parentStreamId?: StreamTabId;
  /**
   * Workflow-script phase owning this run, stamped on the handle before it is
   * tracked so the parent's very first child roster already groups the row.
   * Deliberately not an `onRun` responsibility: `onRun` fires after `track()`
   * has already emitted `child.activity`.
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
  onRunEnd?: (executionId: ExecutionId) => void | Promise<void>;
}

type FlowRecordDisposition = FinalizeExecutionInput['flowRecord'];

/**
 * Flow-record retention: a fixed disposition, or the caller's policy keyed on
 * the terminal outcome {@link finalizeRunTerminal} resolves. Keying it on the
 * caller's own report instead would derive the record's fate from a different
 * owner than the outcome it is persisted beside — a genuinely failed run kept
 * resumable, or a cancelled one stripped of the record every other cancel path
 * preserves.
 */
type FlowRecordRetention =
  FlowRecordDisposition | ((outcome: RunOutcome) => FlowRecordDisposition);

/** Private control channel through which a flow reports its retention policy. */
export interface FlowLifecycleControl {
  setFlowRecordDisposition(disposition: FlowRecordDisposition): void;
}

export type RunTerminalPersistence =
  | { readonly kind: 'skip' }
  | {
      readonly kind: 'finalize';
      readonly flowRecord: FlowRecordRetention;
    };

interface FinalizeRunTerminalParams {
  readonly session: SessionHandle;
  /** Live handle for this terminal attempt; its settled flag is the exactly-once guard. */
  readonly handle: AgentExecutionHandle;
  /** Registry tracking the handle; untracked after the delivery hook runs. */
  readonly executions: Pick<ExecutionRegistry, 'untrack'>;
  /** Status machine owning this run's stream phase; terminalized last. */
  readonly streamStatus: StreamStatusMachine;
  /**
   * The exiting run's own report. The stream phase owns the terminal fact, so
   * this stands only while that phase is still non-terminal — see
   * {@link finalizeRunTerminal}.
   */
  readonly outcome: RunOutcome;
  /**
   * Classified error facts carried on the terminal `result` event, dropped
   * when the stream phase resolves a different outcome than `outcome`.
   */
  readonly error?: ResultEvent['error'];
  /** Run usage totals riding the terminal `result` event, when known. */
  readonly usage?: ResultEvent['usage'];
  readonly isSubagent: boolean;
  /** Transcript stage closed with the outcome's legacy group status (guarded). */
  readonly stage?: Pick<StageHandle, 'end'>;
  /**
   * Emit the terminal `result` event on this trace before settling. Lifecycle
   * runs pass their run trace so session subscribers (`onResult`, host toasts)
   * see the outcome; presentation-only child streams (agent-CLI, background
   * bash) omit it so their per-turn results stay out of the host result plane.
   */
  readonly trace?: AgentTrace;
  /** Durable execution-state action owned by the storage finalizer. */
  readonly persistence: RunTerminalPersistence;
  /**
   * Drain display sidecars before publishing the terminal result. This keeps
   * a waiter that immediately opens the completed-run archive from racing the
   * final transcript or work-plan write. Failures are logged here and retried
   * by the execution-ownership release boundary.
   */
  readonly flushArtifacts?: () => Promise<void>;
  /**
   * Delivery hook (subagent onError) run after the result settles and before
   * untrack, so the parent still sees this child as active while the
   * delivery routes. Receives the resolved outcome so the payload the parent
   * gets reports the same terminal fact as the persisted history and the
   * `result` event. Guarded: a throwing hook cannot abort finalization.
   */
  readonly deliver?: (outcome: RunOutcome) => void | Promise<void>;
}

interface FinalizeRunTerminalResult {
  readonly event: ResultEvent;
}

/**
 * The single owner of terminal run choreography, shared by the run lifecycle
 * arms below, the agent-CLI session loop, and child stream tabs
 * (`finalizeChildStream`): outcome projection to persisted history, transcript
 * stage end, the terminal `result` event (emit + settle), the delivery hook,
 * then registry untrack + terminal stream phase — in that order. Exactly-once
 * per handle: the claim below flips synchronously in the same tick as the
 * check, so a second call (e.g. the lifecycle catch arm after the success arm
 * already finalized, or a concurrent finalize racing across this function's
 * await points) no-ops structurally. A stop of a suspended run claims the same
 * gate (`AgentExecutionHandle.beginSuspendedTermination`), so a kill landing
 * mid-finalize cannot publish a second, contradictory outcome either.
 */
export const finalizeRunTerminal = Effect.fn('finalizeRunTerminal')(function* (
  params: FinalizeRunTerminalParams,
): Effect.fn.Return<FinalizeRunTerminalResult | undefined, Error> {
  const { handle } = params;
  if (!handle.claimTerminalFinalize()) return undefined;
  // The stream phase is the single owner of a run's terminal outcome, so
  // `params.outcome` is the exiting run's report rather than the verdict. A
  // stop that already landed CANCELLED outranks a child whose process then
  // exits non-zero; a turn that already published FAILED outranks a stop that
  // arrived after it. Resolving once here is what lets every projection below
  // (persisted history, stage end, result event, terminal phase) read one
  // value, so no caller has to cross-check the phase for itself.
  const observedPhase = params.streamStatus.get(handle.childStreamId);
  const outcome = isTerminalOutcomePhase(observedPhase)
    ? observedPhase
    : params.outcome;
  // Error facts the run classified for an outcome that did not happen are not
  // facts about this run.
  const error = outcome === params.outcome ? params.error : undefined;
  if (params.persistence.kind === 'finalize') {
    const { flowRecord } = params.persistence;
    const finalization = yield* finalizeRun(params.session, {
      executionId: handle.executionId,
      outcome,
      flowRecord:
        typeof flowRecord === 'function' ? flowRecord(outcome) : flowRecord,
    });
    if (!finalization.ok) {
      logger.warn('Failed to finalize durable execution state', {
        data: {
          agentIdentifier: handle.agentName,
          executionId: handle.executionId,
          outcomePersisted: finalization.outcomePersisted,
          error: finalization.error,
        },
      });
    }
  }
  if (params.stage) {
    const stage = params.stage;
    yield* Effect.try({
      try: () => stage.end(outcome),
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
  if (params.flushArtifacts) {
    yield* Effect.tryPromise({
      try: params.flushArtifacts,
      catch: ensureError,
    }).pipe(
      Effect.catch((artifactError) =>
        Effect.sync(() => {
          logger.warn('Failed to persist pre-terminal display artifacts', {
            data: { executionId: handle.executionId, error: artifactError },
          });
        }),
      ),
    );
  }
  // Emit the terminal result BEFORE untrack so the registry's terminal
  // listener event never precedes the result event, and settle the handle's
  // `result` promise with the same event (F-2: per-run control handle). The
  // event carries the classified error `kind` (when any) and the run usage
  // totals (present once a round recorded usage, including on failures).
  const event: ResultEvent = {
    type: 'result',
    outcome,
    executionId: handle.executionId,
    streamId: handle.childStreamId,
    agentName: handle.agentName,
    category: handle.category,
    isSubagent: params.isSubagent,
    ...(error ? { error } : {}),
    ...(params.usage ? { usage: params.usage } : {}),
  };
  params.trace?.emit(event);
  handle.settleResult(event);
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
  // a throw from untrack's listeners or a stream-status host emit cannot
  // escape past an already-settled result.
  yield* Effect.try({
    try: () => {
      params.executions.untrack(handle.executionId);
      // Refused only when the phase turned terminal after the resolution above,
      // i.e. a stop that landed across this function's own awaits. The phase
      // keeps its own value; the divergence from the published result is real
      // and must stay loud.
      if (
        !params.streamStatus.transitionToTerminal(
          handle.childStreamId,
          outcome,
          STREAM_TRANSITION_CAUSE.LIFECYCLE,
        )
      ) {
        logger.warn('Failed to set terminal stream status', {
          data: {
            agentIdentifier: handle.agentName,
            streamId: handle.childStreamId,
            status: outcome,
          },
        });
      }
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

function transitionRunStart(ctx: AgentLaunchContext): void {
  const { streamId, session } = ctx.runScope;
  const streamStatus = session.status;
  const transitioned =
    streamStatus.transition(
      streamId,
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    ) ||
    streamStatus.transition(
      streamId,
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.RESUME,
    );
  if (transitioned || streamStatus.get(streamId) === STREAM_PHASE.RUNNING) {
    return;
  }
  logger.warn('Failed to transition run to RUNNING', {
    data: {
      agentIdentifier: ctx.config.agent,
      streamId,
    },
  });
}

/**
 * The run's own flow result, relabelled with the outcome finalization resolved.
 *
 * A flow reports the exit it saw; the stream phase decides the run's terminal
 * fact. Everything the parent receives — the delivered payload and the returned
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

/**
 * Claim the stream for a run a stop reached before it could start.
 *
 * The stop's own USER_STOP transition is refused while the stream still carries
 * a previous run's terminal phase (`canTransitionStreamPhase` requires an
 * in-flight `from`), and this run skips the RUNNING claim so the stop it is
 * carrying survives. Without this write the stream would keep the earlier run's
 * COMPLETED/FAILED, and `finalizeRunTerminal` — which reads the phase as the
 * owner of the terminal outcome — would publish and persist that stale verdict
 * for an execution that never ran a turn. Resuming first mirrors the explicit
 * RUNNING choreography `transitionToTerminal` uses to leave WAITING.
 *
 * A phase that already reads CANCELLED needs no write — whether this run's own
 * stop wrote it or a previous run left it, it is the outcome this run is headed
 * for — and rewriting it would publish a RUNNING blip for a run that never ran.
 * A non-terminal phase needs none either: the run's own report stands while the
 * phase carries nothing to inherit.
 */
function transitionStopBeforeRunStart(ctx: AgentLaunchContext): void {
  const { streamId, session } = ctx.runScope;
  const streamStatus = session.status;
  const phase = streamStatus.get(streamId);
  if (phase === STREAM_PHASE.CANCELLED || !isTerminalOutcomePhase(phase)) {
    return;
  }
  const recorded =
    streamStatus.transition(
      streamId,
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.RESUME,
    ) &&
    streamStatus.transition(
      streamId,
      STREAM_PHASE.CANCELLED,
      STREAM_TRANSITION_CAUSE.USER_STOP,
    );
  if (recorded) return;
  logger.warn('Failed to record a stop that landed before run start', {
    data: {
      agentIdentifier: ctx.config.agent,
      streamId,
    },
  });
}

/** Close a suspended run's stage through its session after its trace detached. */
const closeSuspendedTranscriptGroup = Effect.fn(function* (
  session: SessionHandle,
  streamId: StreamTabId,
  parentStageId: string | undefined,
): Effect.fn.Return<void, Error> {
  if (!parentStageId) return;
  session.publishRunEvent(streamId, {
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
 * Wraps a flow runner with full agent run lifecycle management: execution
 * registry tracking, stream-status transitions, error classification, user
 * notifications, and resource disposal.
 *
 * Separating this from `executeAgent` keeps the orchestrator focused on flow
 * routing while this module owns the invariants that must hold across every
 * agent run (registration, status accounting, error surfacing, cleanup).
 */
export const runFlowWithLifecycle = Effect.fn('runFlowWithLifecycle')(
  function* (
    ctx: AgentLaunchContext,
    runner: (
      handle: AgentExecutionHandle,
      lifecycle: FlowLifecycleControl,
    ) => Promise<AgentRuntimeFlowResult>,
    options?: RunFlowLifecycleOptions,
  ): Effect.fn.Return<AgentRuntimeFlowResult, Error> {
    const { streamId, executionId, session } = ctx.runScope;
    const agentIdentifier = ctx.config.agent;
    const parentStreamId = options?.parentStreamId ?? streamId;
    const handle = new AgentExecutionHandle(
      {
        streamId,
        executionId,
        identity: { kind: 'agent', agent: agentIdentifier },
        category: ctx.setting.agentCategory,
      },
      parentStreamId,
      ctx.logger,
    );
    // Roster display fields must be on the handle BEFORE it is tracked:
    // `track()` emits `child.activity` synchronously, so anything assigned
    // later (e.g. from `onRun`) misses the parent's first roster snapshot.
    if (options?.workflowPhase) handle.workflowPhase = options.workflowPhase;
    const runInterruptHandler = {
      interrupt(): void {
        ctx.interrupt();
        session.interactions.cancel({
          streamId,
          cause: 'Run interrupted.',
        });
      },
    };
    const detachRunInterrupt =
      handle.attachInterruptHandler(runInterruptHandler);
    session.executions.track(handle);
    // A lease record removed out from under this run is not watched: the next
    // fenced write throws `ExecutionLeaseLostError` and the run aborts dirty.
    let suspended = false;
    let flowRecordDisposition: FlowRecordDisposition | undefined;
    const lifecycleControl: FlowLifecycleControl = {
      setFlowRecordDisposition(disposition): void {
        flowRecordDisposition = disposition;
      },
    };
    // Expose the live handle to the launcher (F-2). Guarded: neither a synchronous
    // throw nor an async rejection from a consumer callback may abort the run.
    if (options?.onRun) {
      const onRun = options.onRun;
      // Start observation at the same time as invocation. The callback may
      // await handle.result, so its observer must not hold up the flow.
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
      deliver?: (outcome: RunOutcome) => void | Promise<void>;
    }) =>
      finalizeRunTerminal({
        session,
        handle,
        executions: session.executions,
        streamStatus: session.status,
        usage: ctx.usageMonitor.lastTotals(),
        isSubagent: options?.isSubagent ?? false,
        stage: ctx.parentStage,
        trace: ctx.logger,
        flushArtifacts: () => session.flushArtifacts(),
        persistence: {
          kind: 'finalize',
          // Tool-use flows report the exact recovery decision through the
          // private lifecycle control. Other flows retain the historical
          // policy, read against the outcome finalization resolves rather
          // than this arm's report.
          flowRecord: flowRecordDisposition ?? retainFlowRecordUnlessCompleted,
        },
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
      // toRetryErrorInfo strips rawErrorBody, the ResultEvent.error type omits
      // it (bulky, not worth persisting) and a bare object spread would silently
      // smuggle it through past the type check.
      const { message: sdkMsg, ...providerErrorInfo } = toRetryErrorInfo(
        normalizeProviderError(err),
      );
      const errorMsg = `Error executing agent ${agentIdentifier}: ${sdkMsg}`;

      // Root-agent failures are surfaced in the stream log. Subagent failures
      // are delivered to the orchestrator below, so avoid adding a second
      // wrapper error that makes a child failure look like the parent failed.
      if (kind !== 'abort' && !options?.isSubagent) {
        logSdkError(ctx.logger, errorMsg, err, {
          operation: `execute ${agentIdentifier}`,
        });
      }

      const message = kind === 'unexpected' ? errorMsg : sdkMsg;
      // `abort`/`disk-full` route through `formatProviderHttpError`'s
      // `terminalError()` branch, which never populates the provider/
      // credential fields, narrow to the fields it actually sets so
      // `ResultEvent.error`'s per-kind union stays honest (see events.ts).
      // Abort still carries the SDK message for event consumers; the toast
      // mapper intentionally suppresses user-facing notifications for aborts.
      const error: NonNullable<ResultEvent['error']> =
        kind === 'abort' || kind === 'disk-full'
          ? {
              kind,
              message,
              userRetryable: providerErrorInfo.userRetryable,
              streamDiagnostics: providerErrorInfo.streamDiagnostics,
              partialText: providerErrorInfo.partialText,
            }
          : {
              kind,
              message,
              ...providerErrorInfo,
            };
      const subagentResult = options?.isSubagent
        ? (carried ??
          buildTerminalFlowResult(
            handle.category,
            outcome,
            executionId,
            streamId,
            ctx.attachedMemoryMisses,
          ))
        : undefined;
      // One finalize covers all three exits below (subagent / abort / throw).
      // No-ops entirely when the success arm already finalized, so a
      // post-completion throw cannot double-publish a contradictory result.
      // Terminal-error toasts are not emitted here: hosts present them from the
      // `result` event via `session.onResult` + `terminalResultToast` (the
      // single decision point), keeping the run-lifecycle out of host UI.
      const finalized = yield* finalizeTerminal({
        outcome,
        error,
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
          executionId,
          streamId,
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
        try: async () => onRunEnd(executionId),
        catch: ensureError,
      }).pipe(
        Effect.catch((runEndError) =>
          Effect.sync(() => {
            logger.warn('Failed to run the run-end hook', {
              data: { agentIdentifier, streamId, error: runEndError },
            });
          }),
        ),
      );
    });
    const run = Effect.gen(function* () {
      // `run.start` is already out: the launch context published it at its
      // reservation commit point. Publish the run config before the RUNNING
      // transition so progress backends can create the initial
      // StreamExecutionState with the real category when the transition-owned
      // run-start side effects fire.
      ctx.logger.emit({
        type: 'run.config',
        streamId,
        executionId,
        config: ctx.config,
      });
      // The lifecycle owns every stream-status transition: the start claim here,
      // terminal states in the success/error arms below. Runners must not
      // set stream status themselves. Either branch leaves the stream carrying
      // this run's own phase, which is what makes the terminal phase a verdict
      // about this run rather than whatever the last one left behind.
      if (ctx.runScope.signal.aborted) {
        transitionStopBeforeRunStart(ctx);
      } else {
        transitionRunStart(ctx);
      }
      const flow = yield* Effect.try({
        try: () => runner(handle, lifecycleControl),
        catch: ensureError,
      });
      const result = yield* Effect.tryPromise({
        try: () => flow,
        catch: ensureError,
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            // The retained Promise flow owns provider work. Signal its real abort
            // path, then join it before disposing its model and trace resources.
            runInterruptHandler.interrupt();
            yield* Effect.promise(() =>
              flow.then(
                () => undefined,
                () => undefined,
              ),
            );
          }),
        ),
        Effect.ensuring(Effect.sync(detachRunInterrupt)),
      );
      if (isWaitingFlowResult(result)) {
        suspended = true;
        logger.debug(`Task suspended with outcome: ${result.outcome}`);
        // The handle stays tracked (correct for resume) but the live tool-use
        // session and its interrupt handler are already gone by the time
        // this returns (runToolUseFlow's finally). Parking the handle is the
        // one place this run is recorded as suspended, and carries the teardown
        // a stop/kill runs instead of the absent interrupt target, see
        // AgentRunLifecycle/ExecutionRegistry issue #7287.
        handle.suspend(
          Effect.gen(function* () {
            session.followUps.terminalize(streamId);
            // The run trace has detached; publish its stage close through the session.
            yield* closeSuspendedTranscriptGroup(
              session,
              streamId,
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
      const finalized = yield* finalizeTerminal({ outcome: result.outcome });
      // The phase decides the verdict here exactly as in the catch arm: a stop
      // that won on the stream must not let the caller observe COMPLETED.
      const resolvedOutcome = finalized?.event.outcome ?? result.outcome;

      // Onboarding funnel (PRD: agent-native onboarding): State 1 ends when any
      // real run completes. The setup conversation itself doesn't count, but the
      // demo it delegates does (subagent runs land here too). Best-effort: a
      // state write failure must never affect the run.
      if (
        resolvedOutcome === RUN_OUTCOME.COMPLETED &&
        baseAgentName(agentIdentifier) !== SETUP_AGENT_NAME
      ) {
        yield* Effect.tryPromise({
          try: async () => {
            const { globalState } = platform();
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
          // Settle every host interaction this run left pending. The lifecycle owns
          // it for both flows: a run that ends with an approval still on screen must
          // release the host whether it completed, failed, was stopped, or parked at
          // WAITING. The interrupt-time cancel a stop performs stays with the
          // interrupt handler, which has to settle the prompt before the flow can
          // unwind; a second cancel here matches nothing and is a no-op. Guarded so a
          // throwing host adapter cannot replace the result this run already
          // published.
          yield* Effect.try({
            try: () =>
              session.interactions.cancel({ streamId, cause: 'Run ended.' }),
            catch: ensureError,
          }).pipe(
            Effect.catch((cancelError) =>
              Effect.sync(() => {
                logger.warn(
                  'Failed to cancel host interactions after the run ended',
                  {
                    data: { agentIdentifier, streamId, error: cancelError },
                  },
                );
              }),
            ),
          );
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
          // Release long-lived resources (e.g., WebSocket connections, keepalive
          // intervals) to prevent leaks when handler instances are discarded after
          // execution. The cell disposed each handler a mid-run switch retired, so
          // this closes the one still live.
          ctx.modelCell.dispose();
          // Drop the run-trace subscribers (channel sink + transcript recorder) so
          // they don't pile up across many agent runs.
          ctx.disposeTrace();
        }),
      ),
    );
  },
);
