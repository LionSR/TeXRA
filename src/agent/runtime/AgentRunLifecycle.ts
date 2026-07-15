import { platform } from '@platform/platform';
import { finalizeExecution, type FinalizeExecutionInput } from '@agent/storage';
import {
  logSdkError,
  type AgentTrace,
  type ResultEvent,
  type StageHandle,
} from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AGENT_ERROR_OUTCOME,
  AgentError,
  classifyAgentError,
  normalizeProviderError,
} from '@common/errors';
import {
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  buildRunDescriptor,
  toRetryErrorInfo,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { projectRunOutcome } from '@shared/streams/streamStatus';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { agentName as baseAgentName } from '@shared/schemas/agent';
import {
  getFirstRunDone,
  setFirstRunDone,
} from '@shared/state/onboardingState';

import {
  AgentExecutionHandle,
  type AgentRunHandle,
  type ExecutionRegistry,
} from './executionRegistry';
import {
  getAgentFlowErrorResult,
  buildTerminalFlowResult,
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import type { AgentLaunchContext } from './AgentLaunchContext';
import type { StreamStatusMachine } from './StreamStatusService';

const logger = createChannelTrace('agentRunLifecycle');

export interface RunFlowLifecycleOptions {
  isSubagent?: boolean;
  parentStreamId?: StreamTabId;
  onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
  /**
   * Fires once with the live per-run handle, right after it is tracked (F-2) —
   * the additive exposure of the control handle (`.trace`, `.result`, interrupt
   * via `executions`). Throwing here must not abort the run, so it is guarded.
   */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
}

export type FlowRecordDisposition = FinalizeExecutionInput['flowRecord'];

/** Private control channel through which a flow reports its retention policy. */
export interface FlowLifecycleControl {
  setFlowRecordDisposition(disposition: FlowRecordDisposition): void;
}

export interface FinalizeRunTerminalParams {
  /** Live handle for this terminal attempt; its settled flag is the exactly-once guard. */
  readonly handle: AgentExecutionHandle;
  /** Registry tracking the handle; untracked after the delivery hook runs. */
  readonly executions: Pick<ExecutionRegistry, 'untrack'>;
  /** Status machine owning this run's stream phase; terminalized last. */
  readonly streamStatus: StreamStatusMachine;
  /** The run's canonical terminal fact; every write below is a projection of it. */
  readonly outcome: RunOutcome;
  /** Classified error facts carried on the terminal `result` event. */
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
  readonly persistence:
    | { readonly kind: 'skip' }
    | {
        readonly kind: 'finalize';
        readonly flowRecord: FinalizeExecutionInput['flowRecord'];
      };
  /**
   * Delivery hook (subagent onError) run after the result settles and before
   * untrack, so the parent still sees this child as active while the
   * delivery routes. Guarded: a throwing hook cannot abort finalization.
   */
  readonly deliver?: () => void | Promise<void>;
}

export interface FinalizeRunTerminalResult {
  readonly event: ResultEvent;
  readonly terminalStatusPersisted: boolean;
}

/**
 * The single owner of terminal run choreography, shared by the run lifecycle
 * arms below, the agent-CLI session loop, and child stream tabs
 * (`finalizeChildStream`): waiting-cleanup clear, outcome projection to
 * persisted history, transcript stage end, the terminal `result` event
 * (emit + settle), the delivery hook, then registry untrack + terminal stream
 * phase — in that order. Exactly-once per handle: the claim below flips
 * synchronously in the same tick as the check, so a second call (e.g. the
 * lifecycle catch arm after the success arm already finalized, a concurrent
 * finalize racing across this function's await points, or a finalize after a
 * `terminateWaitingHandle` already settled the handle) no-ops structurally.
 */
export async function finalizeRunTerminal(
  params: FinalizeRunTerminalParams,
): Promise<FinalizeRunTerminalResult | undefined> {
  const { handle, outcome } = params;
  if (!handle.claimTerminalFinalize()) return undefined;
  // This run is terminating, not suspending: drop any waiting-cleanup
  // registered on this handle before teardown detaches the interrupt handler —
  // otherwise ExecutionRegistry.terminate() could mistake this handle for a
  // suspended one in the window between interrupt-handler detach and untrack.
  // Defensive: this function's own WAITING branch never reaches
  // finalizeRunTerminal on the same call (it returns early), so there is no
  // live registration to clear in the common case — this guards a future
  // caller that registers one outside that branch.
  handle.clearWaitingCleanup();
  let terminalStatusPersisted = false;
  if (params.persistence.kind === 'finalize') {
    try {
      const finalization = await finalizeExecution({
        executionId: handle.executionId,
        terminalStatus: projectRunOutcome(outcome).executionStatus,
        flowRecord: params.persistence.flowRecord,
      });
      if (finalization.status === 'failed') {
        logger.warn('Failed to finalize durable execution state', {
          data: {
            agentIdentifier: handle.agentName,
            executionId: handle.executionId,
            stage: finalization.stage,
            terminalStatusPersisted: finalization.terminalStatusPersisted,
            error: finalization.error,
          },
        });
      }
      terminalStatusPersisted = finalization.terminalStatusPersisted;
    } catch (error) {
      logger.warn('Execution finalizer rejected unexpectedly', {
        data: {
          agentIdentifier: handle.agentName,
          executionId: handle.executionId,
          error,
        },
      });
    }
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
    ...(params.error ? { error: params.error } : {}),
    ...(params.usage ? { usage: params.usage } : {}),
  };
  params.trace?.emit(event);
  handle.settleResult(event);
  if (params.deliver) {
    try {
      await params.deliver();
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
    if (
      !params.streamStatus.transitionToTerminal(handle.childStreamId, outcome, {
        trace: handle.trace,
      })
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
  return { event, terminalStatusPersisted };
}

function transitionRunStart(ctx: AgentLaunchContext): void {
  const { streamId, session } = ctx.runScope;
  const streamStatus = session.status;
  const options = {
    trace: ctx.logger,
  };
  if (
    streamStatus.transition(
      streamId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
      options,
    )
  ) {
    return;
  }
  const resumed = streamStatus.transition(
    streamId,
    STREAM_PHASE.RUNNING,
    'resume',
    options,
  );
  if (resumed) {
    return;
  }
  if (streamStatus.get(streamId) === STREAM_PHASE.RUNNING) {
    return;
  }
  logger.warn('Failed to transition run to RUNNING', {
    data: {
      agentIdentifier: ctx.config.agent,
      streamId,
    },
  });
}

function emitRunStart(ctx: AgentLaunchContext): void {
  const { streamId, executionId } = ctx.runScope;
  // Launch construction receives already-normalized AgentConfig; descriptor
  // parse failures here indicate an internal run-contract violation.
  const descriptor = buildRunDescriptor({
    streamId,
    executionId,
    agent: ctx.config.agent,
    category: ctx.setting.agentCategory,
  });
  ctx.logger.emit({ type: 'run.start', descriptor });
  ctx.logger.emit({
    type: 'run.config',
    streamId,
    executionId,
    config: ctx.config,
  });
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
  const { streamId, executionId, runtimeHost, session } = ctx.runScope;
  const agentIdentifier = ctx.config.agent;
  const category =
    ctx.setting.agentCategory === AgentCategory.ToolUse
      ? 'toolUse'
      : 'workflow';
  const parentStreamId = options?.parentStreamId ?? streamId;
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    streamId,
    agentIdentifier,
    category,
    runtimeHost,
    ctx.logger,
  );
  handle.enablePendingInterrupt();
  // A session that binds this handle after launch (cross-window rebind) has
  // missed the emitRunStart() `run.config` below and replays it from here (#8258).
  handle.initialRunFacts = { config: ctx.config };
  session.executions.track(handle);
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
      const maybePromise = options.onRun(handle);
      void Promise.resolve(maybePromise).catch((err: unknown) =>
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
    deliver?: () => void | Promise<void>;
  }): Promise<FinalizeRunTerminalResult | undefined> =>
    finalizeRunTerminal({
      handle,
      executions: session.executions,
      streamStatus: session.status,
      usage: ctx.usageMonitor.lastTotals(),
      isSubagent: options?.isSubagent ?? false,
      stage: ctx.parentStage,
      trace: ctx.logger,
      persistence: {
        kind: 'finalize',
        // Tool-use flows report the exact recovery decision through the
        // private lifecycle control. Other flows retain the historical policy.
        flowRecord:
          flowRecordDisposition ??
          (arm.outcome === RUN_OUTCOME.COMPLETED ? 'delete' : 'preserve'),
      },
      ...arm,
    });
  try {
    // Publish run identity/config before the RUNNING transition so progress
    // backends can create the initial StreamExecutionState with the real
    // category when the transition-owned run-start side effects fire.
    emitRunStart(ctx);
    // The lifecycle owns every stream-status transition: RUNNING here,
    // terminal states in the success/error arms below. Runners must not
    // set stream status themselves.
    if (!handle.hasPendingInterrupt) transitionRunStart(ctx);
    let result: AgentRuntimeFlowResult;
    try {
      result = await runner(handle, lifecycleControl);
    } finally {
      handle.closePendingInterruptWindow();
    }
    if (isWaitingFlowResult(result)) {
      logger.debug(`Task suspended with outcome: ${result.outcome}`);
      // The handle stays tracked (correct for resume) but the live tool-use
      // session and its interrupt handler are already gone by the time
      // this returns (runToolUseFlow's finally). Register a fallback so a
      // stop/kill during the suspended window still tears this down instead
      // of ExecutionRegistry.terminate() finding no interrupt target and
      // no-oping — see AgentRunLifecycle/ExecutionRegistry issue #7287.
      const parentStageId = ctx.parentStage.id;
      handle.registerWaitingCleanup(() => {
        session.followUps.release(streamId);
        // Close this turn's "Run: ..." transcript group so a killed suspended
        // subagent doesn't leave it stuck at `running` forever (every other
        // terminal path reaches this via `finalizeRunTerminal`'s stage end,
        // but this WAITING branch never does — the kill path never resumes).
        // Calling `ctx.parentStage.end()` here would be
        // a silent no-op: this function's own `finally` below calls
        // `ctx.disposeTrace()` unconditionally the instant this branch
        // returns — long before a later kill can invoke this closure — which
        // unsubscribes the transcript recorder from `ctx.parentStage`'s trace
        // (see `createRunTrace`'s `dispose`). Emitting `stage.end` through an
        // already-desubscribed trace reaches no subscriber, so update the
        // session's transcript store directly instead, mirroring exactly what
        // `TexraTranscriptRecorder`'s own `stage.end` handler writes for a
        // `kind: 'run'` stage (see `beginRunStage` in AgentLaunchContext.ts).
        // Each suspension opens its own stage id (fresh `nanoid` per
        // `beginRunStage` call, including on resume), so this can never
        // double-close a stage some other turn already ended.
        if (parentStageId) {
          session.transcripts.update(streamId, parentStageId, {
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            data: {
              status: RUN_OUTCOME.CANCELLED,
              endTime: Date.now(),
              kind: 'run',
            },
          });
        }
      });
      return result;
    }
    // Onboarding funnel (PRD: agent-native onboarding): State 1 ends when any
    // real run completes. The setup conversation itself doesn't count, but the
    // demo it delegates does (subagent runs land here too). Best-effort: a
    // state write failure must never affect the run.
    if (
      result.outcome === RUN_OUTCOME.COMPLETED &&
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

    // The flow's outcome is the canonical terminal fact; the finalizer owns
    // every projection of it. No other layer may re-derive these. Success
    // has no delivery hook: a native subagent's own turn value IS the
    // strategy's returned result (see childRunLoop.ts), so there is nothing
    // left to deliver here — only a subagent failure needs the caller to
    // format and route an error (see the catch arm's `onError` below).
    await finalizeTerminal({ outcome: result.outcome });
    logger.debug(`Task completed with outcome: ${result.outcome}`);
    return result;
  } catch (err) {
    const kind = classifyAgentError(err);
    const outcome = AGENT_ERROR_OUTCOME[kind];
    // normalizeProviderError recovers the structured shape attached at the
    // flow-exit rethrows (T2-2) when one was attached, or formats a fresh one
    // otherwise. toRetryErrorInfo strips rawErrorBody — the ResultEvent.error
    // type omits it (bulky, not worth persisting) and a bare object spread
    // would silently smuggle it through past the type check.
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
      ? (getAgentFlowErrorResult(err) ??
        buildTerminalFlowResult(
          category,
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
    await finalizeTerminal({
      outcome,
      error,
      deliver:
        subagentResult && options?.onError
          ? () => options.onError?.(err, subagentResult)
          : undefined,
    });

    if (subagentResult) {
      return subagentResult;
    }
    if (kind === 'abort') {
      return buildTerminalFlowResult(
        category,
        outcome,
        executionId,
        streamId,
        ctx.attachedMemoryMisses,
      );
    }

    throw new AgentError(errorMsg, { cause: err });
  } finally {
    // Release long-lived resources (e.g., WebSocket connections, keepalive intervals)
    // to prevent leaks when handler instances are discarded after execution.
    ctx.modelHandler.dispose();
    // Drop the run-trace subscribers (channel sink + transcript recorder) so
    // they don't pile up across many agent runs.
    ctx.disposeTrace();
  }
}
