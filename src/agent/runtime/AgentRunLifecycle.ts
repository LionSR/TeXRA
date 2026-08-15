import type { FinalizeExecutionInput } from '@agent/storage';
import {
  logSdkError,
  type AgentTrace,
  type ResultEvent,
  type StageHandle,
} from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  onOwnedExecutionLeaseLost,
  captureOwnedExecutionLeaseIfPresent,
} from '@agent/storage/executionLease';
import { persistTerminalExecution } from '@agent/storage/terminalPersistence';
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
import {
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  toRetryErrorInfo,
  type ExecutionId,
  type RetryErrorInfo,
  type RunOutcome,
  type StreamTabId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import {
  isTerminalOutcomePhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import {
  getFirstRunDone,
  setFirstRunDone,
} from '@shared/state/onboardingState';
import { agentName as baseAgentName } from '@shared/schemas/agent';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
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
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport?: UserFollowUpSupport;
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
   * teardown for a later kill) and the guard rails (skipped for subagents and
   * WAITING suspensions, logged rather than rethrown), but not *what* it does.
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

export interface FinalizeRunTerminalParams {
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

export interface FinalizeRunTerminalResult {
  readonly event: ResultEvent;
  readonly outcomePersisted: boolean;
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
export async function finalizeRunTerminal(
  params: FinalizeRunTerminalParams,
): Promise<FinalizeRunTerminalResult | undefined> {
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
  let outcomePersisted = false;
  if (params.persistence.kind === 'finalize') {
    const { flowRecord } = params.persistence;
    const persisted = await persistTerminalExecution({
      executionId: handle.executionId,
      agentName: handle.agentName,
      outcome,
      flowRecord:
        typeof flowRecord === 'function' ? flowRecord(outcome) : flowRecord,
      logger,
      failedMessage: 'Failed to finalize durable execution state',
    });
    outcomePersisted = persisted.outcomePersisted;
  }
  if (params.stage) {
    try {
      params.stage.end(outcome);
    } catch (stageErr) {
      logger.warn('Failed to end parent stage', {
        data: { agentIdentifier: handle.agentName, error: stageErr },
      });
    }
  }
  if (params.flushArtifacts) {
    try {
      await params.flushArtifacts();
    } catch (artifactError) {
      logger.warn('Failed to persist pre-terminal display artifacts', {
        data: { executionId: handle.executionId, error: artifactError },
      });
    }
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
    try {
      await params.deliver(outcome);
    } catch (deliveryError) {
      logger.warn('Terminal delivery hook failed', {
        data: { agentIdentifier: handle.agentName, error: deliveryError },
      });
    }
  }
  // The run has produced its canonical terminal result. Guard the cleanup so
  // a throw from untrack's listeners or a stream-status host emit cannot
  // escape past an already-settled result.
  try {
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
  } catch (cleanupErr) {
    logger.warn('Post-terminal cleanup threw', {
      data: { agentIdentifier: handle.agentName, error: cleanupErr },
    });
  }
  return { event, outcomePersisted };
}

/** Failures finalizeFailedRun already logged, published, and wrapped; the
 *  outer catch rethrows these untouched instead of finalizing them again. */
const finalizedRunFailures = new WeakSet<Error>();

/**
 * Recover a run's carried failure as an `Error`, so the one failure path below
 * classifies and logs a reported failure exactly as it does an exception that
 * escaped the flow.
 *
 * `RetryErrorInfo` is a `ProviderError` minus the bulky `rawErrorBody`, so it
 * attaches as-is: the missing field stays absent and `isRelayError` stays
 * `undefined` when it was, keeping `normalizeProviderError` from reading a
 * wrong relay verdict off the retry-state shape.
 */
function toFlowFailureError(error: RetryErrorInfo): Error {
  const failure = new Error(error.message);
  attachProviderError(failure, error);
  // The classifiers for these kinds read Error markers; the flatten carried
  // the verdicts as fields, so restore the markers on the rebuilt Error.
  if (error.missingApiKey) attachMissingApiKeyError(failure);
  if (error.contextWindow) attachContextWindowError(failure);
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

/**
 * Close the "Run: ..." transcript group a suspended subagent leaves open.
 *
 * The suspended-handle teardown a stop/kill runs (see the WAITING branch of
 * {@link runFlowWithLifecycle}) reaches this instead of the transcript stage
 * abstraction. Calling `ctx.parentStage.end()` there would be a silent no-op:
 * `runFlowWithLifecycle`'s own `finally` calls `ctx.disposeTrace()`
 * unconditionally the instant the WAITING branch returns — long before a later
 * kill can invoke the teardown — which unsubscribes the transcript recorder
 * from the parent stage's trace (see `createRunTrace`'s `dispose`). Emitting
 * `stage.end` through an already-desubscribed trace reaches no subscriber, so
 * update the session's transcript store directly instead, mirroring exactly
 * what `TexraTranscriptRecorder`'s own `stage.end` handler writes for a
 * `kind: 'run'` stage (see `beginRunStage` in AgentLaunchContext.ts). Each
 * suspension opens its own stage id (fresh `nanoid` per `beginRunStage` call,
 * including on resume), so this can never double-close a stage some other turn
 * already ended.
 */
async function closeSuspendedTranscriptGroup(
  session: SessionHandle,
  streamId: StreamTabId,
  handle: AgentExecutionHandle,
  parentStageId: string | undefined,
): Promise<void> {
  if (handle.executionLeaseLost) return;
  if (!parentStageId) return;
  const writer = await session.transcripts.loadAndAcquireWriter(
    streamId,
    handle.executionId,
  );
  try {
    if (handle.executionLeaseLost) return;
    writer.update(parentStageId, {
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: {
        status: RUN_OUTCOME.CANCELLED,
        endTime: Date.now(),
        kind: 'run',
      },
    });
  } finally {
    writer.close();
  }
}

/**
 * Wraps a flow runner with full agent run lifecycle management: execution
 * registry tracking, stream-status transitions, error classification, user
 * notifications, and resource disposal.
 *
 * Separating this from `executeAgent` keeps the orchestrator focused on flow
 * routing while this module owns the invariants that must hold across every
 * agent run (registration, status accounting, error surfacing, cleanup).
 */
export async function runFlowWithLifecycle(
  ctx: AgentLaunchContext,
  runner: (
    handle: AgentExecutionHandle,
    lifecycle: FlowLifecycleControl,
  ) => Promise<AgentRuntimeFlowResult>,
  options?: RunFlowLifecycleOptions,
): Promise<AgentRuntimeFlowResult> {
  const { streamId, executionId, session } = ctx.runScope;
  const agentIdentifier = ctx.config.agent;
  const parentStreamId = options?.parentStreamId ?? streamId;
  const userFollowUpSupport =
    options?.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
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
  const executionLeaseScope = captureOwnedExecutionLeaseIfPresent(executionId);
  if (executionLeaseScope) {
    handle.attachExecutionLeaseScope(executionLeaseScope);
  }
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
  const detachRunInterrupt = handle.attachInterruptHandler(runInterruptHandler);
  session.executions.track(handle);
  let leaseLost = false;
  let keepLeaseWatcher = false;
  const stopWatchingLease = onOwnedExecutionLeaseLost(executionId, () => {
    leaseLost = true;
    handle.markExecutionLeaseLost();
    logger.error('Execution lease was lost; interrupting the former owner', {
      data: { executionId, streamId },
    });
    handle.interrupt();
  });
  let flowRecordDisposition: FlowRecordDisposition | undefined;
  const lifecycleControl: FlowLifecycleControl = {
    setFlowRecordDisposition(disposition): void {
      flowRecordDisposition = disposition;
    },
  };
  // Expose the live handle to the launcher (F-2). Guarded: neither a synchronous
  // throw nor an async rejection from a consumer callback may abort the run.
  if (options?.onRun) {
    try {
      void Promise.resolve(options.onRun(handle)).catch((err: unknown) =>
        logger.warn('onRun callback rejected', {
          data: { agentIdentifier, error: err },
        }),
      );
    } catch (err) {
      logger.warn('onRun callback threw', {
        data: { agentIdentifier, error: err },
      });
    }
  }
  // Shared parameterization of the terminal finalizer for both arms below;
  // outcome, error facts, and the delivery hook are the only per-arm inputs.
  const finalizeTerminal = (arm: {
    outcome: RunOutcome;
    error?: ResultEvent['error'];
    deliver?: (outcome: RunOutcome) => void | Promise<void>;
  }): Promise<FinalizeRunTerminalResult | undefined> =>
    finalizeRunTerminal({
      handle,
      executions: session.executions,
      streamStatus: session.status,
      usage: ctx.usageMonitor.lastTotals(),
      isSubagent: options?.isSubagent ?? false,
      stage: ctx.parentStage,
      trace: ctx.logger,
      flushArtifacts: () => session.flushArtifacts(handle.executionId),
      persistence: leaseLost
        ? { kind: 'skip' }
        : {
            kind: 'finalize',
            // Tool-use flows report the exact recovery decision through the
            // private lifecycle control. Other flows retain the historical
            // policy, read against the outcome finalization resolves rather
            // than this arm's report.
            flowRecord:
              flowRecordDisposition ??
              ((resolved) =>
                resolved === RUN_OUTCOME.COMPLETED ? 'delete' : 'preserve'),
          },
      ...arm,
    });
  /**
   * The single owner of a failed run's exit, entered from both arms below: a
   * flow that reported FAILED on its result (`carried`, whose structured error
   * arrives recovered onto `err`) and an exception that escaped the runner
   * without one. Classification, the run log, the terminal `result` event's
   * error facts, subagent delivery, and the `AgentError` a root caller sees all
   * happen here, so a carried failure is exactly as loud as a thrown one.
   */
  const finalizeFailedRun = async (
    err: unknown,
    carried: AgentFlowResult | undefined,
  ): Promise<AgentFlowResult> => {
    const kind = classifyAgentError(err);
    const outcome = AGENT_ERROR_OUTCOME[kind];
    // normalizeProviderError recovers the structured shape the flow attached
    // (T2-2) when there was one, or formats a fresh one otherwise.
    // toRetryErrorInfo strips rawErrorBody — the ResultEvent.error type omits
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
    // `terminalError()` branch, which never populates the provider/relay/
    // credential fields — narrow to the fields it actually sets so
    // `ResultEvent.error`'s per-kind union stays honest (see events.ts).
    // Abort still carries the SDK message for event consumers; the toast
    // mapper intentionally suppresses user-facing notifications for aborts.
    const error: NonNullable<ResultEvent['error']> =
      kind === 'abort' || kind === 'disk-full'
        ? {
            kind,
            message,
            userRetryable: providerErrorInfo.userRetryable,
            isRelayError: providerErrorInfo.isRelayError,
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
    const finalized = await finalizeTerminal({
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
    throw finalizedFailure;
  };
  /**
   * Invoke the composition-supplied run-end hook when the run genuinely ends.
   * The lifecycle owns the guard rails: subagent runs do not invoke it (the
   * parent owns the worktree), and the WAITING branch invokes it only from the
   * parked-handle teardown if a later kill actually ends the run.
   */
  const runOnRunEnd = async (): Promise<void> => {
    if (options?.isSubagent) return;
    if (!options?.onRunEnd) return;
    try {
      await options.onRunEnd(executionId);
    } catch (runEndError) {
      logger.warn('Failed to run the run-end hook', {
        data: { agentIdentifier, streamId, error: runEndError },
      });
    }
  };
  try {
    // Publish run identity/config before the RUNNING transition so progress
    // backends can create the initial StreamExecutionState with the real
    // category when the transition-owned run-start side effects fire.
    ctx.logger.emit({
      type: 'run.start',
      streamId,
      executionId,
      identity: handle.identity,
      userFollowUpSupport,
    });
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
    let result: AgentRuntimeFlowResult;
    try {
      result = await runner(handle, lifecycleControl);
    } finally {
      // Once the runner settles there is no live run operation left to abort.
      // Refuse later stops while terminal persistence completes, matching the
      // registry contract that an interrupt target represents live work.
      detachRunInterrupt();
    }
    if (isWaitingFlowResult(result)) {
      keepLeaseWatcher = true;
      logger.debug(`Task suspended with outcome: ${result.outcome}`);
      // The handle stays tracked (correct for resume) but the live tool-use
      // session and its interrupt handler are already gone by the time
      // this returns (runToolUseFlow's finally). Parking the handle is the
      // one place this run is recorded as suspended, and carries the teardown
      // a stop/kill runs instead of the absent interrupt target — see
      // AgentRunLifecycle/ExecutionRegistry issue #7287.
      handle.suspend(async () => {
        session.followUps.terminalize(streamId);
        // See closeSuspendedTranscriptGroup for why this closes the transcript
        // group via the store instead of the stage abstraction, and for the
        // dispose-ordering caveat that makes the stage path a silent no-op.
        await closeSuspendedTranscriptGroup(
          session,
          streamId,
          handle,
          ctx.parentStage.id,
        );
        // A parked run that a later stop/kill tears down has ended here,
        // through the suspended-handle path instead of the success/error arms.
        // Stop its Lean servers on that path too; the WAITING return above
        // deliberately did not.
        await runOnRunEnd();
      });
      return result;
    }
    // A flow that failed reports it on the result it returns, together with the
    // response, files, and cost it did produce. That is a failed run, not a
    // successful one with an error field, so it exits through the same owner an
    // escaped exception does.
    if (result.error) {
      return await finalizeFailedRun(toFlowFailureError(result.error), result);
    }
    // Persist the terminal fact before any supplementary UX state. In
    // particular, a completed tool-use flow must not remain resumable while an
    // onboarding write is pending.
    const finalized = await finalizeTerminal({ outcome: result.outcome });
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
      try {
        const { globalState } = platform();
        if (!getFirstRunDone(globalState)) {
          await setFirstRunDone(globalState, true);
        }
      } catch {
        // Ignore: the flag is a UX nicety, never run-critical.
      }
    }

    logger.debug(`Task completed with outcome: ${resolvedOutcome}`);
    return withResolvedOutcome(result, resolvedOutcome);
  } catch (err) {
    // A carried failure already went through finalizeFailedRun on the return
    // path above; its AgentError must not be logged and classified twice.
    if (err instanceof Error && finalizedRunFailures.has(err)) throw err;
    return await finalizeFailedRun(err, undefined);
  } finally {
    detachRunInterrupt();
    if (!keepLeaseWatcher) stopWatchingLease();
    // Settle every host interaction this run left pending. The lifecycle owns
    // it for both flows: a run that ends with an approval still on screen must
    // release the host whether it completed, failed, was stopped, or parked at
    // WAITING. The interrupt-time cancel a stop performs stays with the
    // interrupt handler, which has to settle the prompt before the flow can
    // unwind; a second cancel here matches nothing and is a no-op. Guarded so a
    // throwing host adapter cannot replace the result this run already
    // published.
    try {
      session.interactions.cancel({ streamId, cause: 'Run ended.' });
    } catch (cancelError) {
      logger.warn('Failed to cancel host interactions after the run ended', {
        data: { agentIdentifier, streamId, error: cancelError },
      });
    }
    // Stop the Lean servers attributed to this run in its worktree(s) so they
    // do not idle until the timeout after the run is gone (CLI/desktop; a host
    // whose Lean integration owns server lifetime no-ops here). Servers still
    // leased by another run's in-flight request survive on the idle-timeout
    // backstop. Guarded like the cancel above: a failing stop must not
    // replace the result this run already published. A WAITING suspension is
    // not a run end, so its return skips this and leaves the stop to the
    // suspended-handle teardown if a later kill actually ends the run.
    if (!keepLeaseWatcher) {
      await runOnRunEnd();
    }
    // Release long-lived resources (e.g., WebSocket connections, keepalive
    // intervals) to prevent leaks when handler instances are discarded after
    // execution. The cell disposed each handler a mid-run switch retired, so
    // this closes the one still live.
    ctx.modelCell.dispose();
    // Drop the run-trace subscribers (channel sink + transcript recorder) so
    // they don't pile up across many agent runs.
    ctx.disposeTrace();
  }
}
