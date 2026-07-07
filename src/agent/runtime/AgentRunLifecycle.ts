import {
  getFirstRunDone,
  setFirstRunDone,
} from '@controllers/onboarding/onboardingFunnel';
import { platform } from '@platform/platform';
import { getExecutionStore, writeTerminalStatus } from '@agent/storage';
import { logSdkError, type ResultEvent } from '@agent/trace';
import { flowKey } from '@agent/node/persistedFlow';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import {
  AGENT_ERROR_OUTCOME,
  AgentError,
  classifyAgentError,
  getSdkErrorMessage,
  normalizeProviderError,
} from '@common/errors';
import {
  legacyEndGroupStatusForOutcome,
  projectRunOutcome,
} from '@common/constants/streamStatus';
import { createChannelTrace } from '@logger';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  buildRunDescriptor,
  toRetryErrorInfo,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { agentName as baseAgentName } from '@shared/schemas/agent';

import { AgentExecutionHandle, type AgentRunHandle } from './executionRegistry';
import {
  getAgentFlowErrorResult,
  buildTerminalFlowResult,
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import type { AgentLaunchContext } from './AgentLaunchContext';

const logger = createChannelTrace('agentRunLifecycle');

export interface RunFlowLifecycleOptions {
  isSubagent?: boolean;
  parentStreamId?: StreamTabId;
  onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
  /**
   * Fires once with the live per-run handle, right after it is tracked (F-2) —
   * the additive exposure of the control handle (`.trace`, `.result`, interrupt
   * via `executions`). Throwing here must not abort the run, so it is guarded.
   */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
}

/** Map the canonical run outcome onto the terminal `result` event's outcome. */
function toResultOutcome(outcome: RunOutcome): ResultEvent['outcome'] {
  if (outcome === RUN_OUTCOME.COMPLETED) return 'completed';
  if (outcome === RUN_OUTCOME.CANCELLED) return 'cancelled';
  return 'failed';
}

/**
 * Emit the terminal `result` event on the run's trace — the single emission
 * boundary for run outcomes. Carries the classified error `kind` (when any) and
 * the run usage totals (present once a round recorded usage, including on
 * failures, via the UsageMonitor cache).
 */
function emitRunResult(
  ctx: AgentLaunchContext,
  category: 'toolUse' | 'workflow',
  outcome: ResultEvent['outcome'],
  isSubagent: boolean,
  error?: ResultEvent['error'],
): ResultEvent {
  const usage = ctx.usageMonitor.lastTotals();
  const event: ResultEvent = {
    type: 'result',
    outcome,
    executionId: ctx.executionId,
    streamId: ctx.streamId,
    agentName: ctx.config.agent,
    category,
    isSubagent,
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
  };
  ctx.logger.emit(event);
  return event;
}

function endParentStageSafely(
  ctx: AgentLaunchContext,
  agentIdentifier: string,
  status: Parameters<AgentLaunchContext['parentStage']['end']>[0],
): void {
  try {
    ctx.parentStage.end(status);
  } catch (stageErr) {
    logger.warn('Failed to end parent stage', {
      data: { agentIdentifier, error: stageErr },
    });
  }
}

function transitionRunStart(ctx: AgentLaunchContext): void {
  const options = {
    runtimeHost: ctx.runtimeHost,
    trace: ctx.logger,
  };
  if (
    ctx.streamStatus.transition(
      ctx.streamId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
      options,
    )
  ) {
    return;
  }
  const resumed = ctx.streamStatus.transition(
    ctx.streamId,
    STREAM_PHASE.RUNNING,
    'resume',
    options,
  );
  if (resumed) {
    return;
  }
  if (ctx.streamStatus.get(ctx.streamId) === STREAM_PHASE.RUNNING) {
    return;
  }
  logger.warn('Failed to transition run to RUNNING', {
    data: {
      agentIdentifier: ctx.config.agent,
      streamId: ctx.streamId,
    },
  });
}

function emitRunStart(ctx: AgentLaunchContext): void {
  // Launch construction receives already-normalized AgentConfig; descriptor
  // parse failures here indicate an internal run-contract violation.
  const descriptor = buildRunDescriptor({
    streamId: ctx.streamId,
    executionId: ctx.executionId,
    agent: ctx.config.agent,
    category: ctx.setting.agentCategory,
  });
  ctx.logger.emit({ type: 'run.start', descriptor });

  // Legacy compatibility for hosts still ingressing run identity through the
  // ProgressEventBus. The snapshot store no longer persists `taskState`.
  ctx.runtimeHost.emit('setTaskState', {
    streamId: ctx.streamId,
    executionId: ctx.executionId,
    taskState: agentConfigToTaskState(ctx.config),
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
  runner: (handle: AgentExecutionHandle) => Promise<AgentRuntimeFlowResult>,
  options?: RunFlowLifecycleOptions,
): Promise<AgentRuntimeFlowResult> {
  const { streamId, session } = ctx;
  const agentIdentifier = ctx.config.agent;
  const category =
    ctx.setting.agentCategory === AgentCategory.ToolUse
      ? 'toolUse'
      : 'workflow';
  const parentStreamId = options?.parentStreamId ?? streamId;
  const handle = new AgentExecutionHandle(
    ctx.executionId,
    parentStreamId,
    streamId,
    agentIdentifier,
    category,
    ctx.runtimeHost,
    ctx.coordinators,
    ctx.logger,
  );
  session.executions.track(handle);
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
  // Tracks whether the terminal `result` event has already been emitted, so a
  // throw in the success arm's post-emit cleanup can never fall into the catch
  // arm and publish a second, contradictory `failed` result for a finished run.
  let resultEmitted = false;
  try {
    // Publish run identity/config before the RUNNING transition so progress
    // backends can create the initial StreamExecutionState with the real
    // category when the transition-owned run-start side effects fire.
    emitRunStart(ctx);
    // The lifecycle owns every stream-status transition: RUNNING here,
    // terminal states in the success/error arms below. Runners must not
    // set stream status themselves.
    transitionRunStart(ctx);
    const result = await runner(handle);
    if (isWaitingFlowResult(result)) {
      logger.debug(`Task suspended with outcome: ${result.outcome}`);
      // The handle stays tracked (correct for resume) but the live tool-use
      // session and its interrupt registration are already gone by the time
      // this returns (runToolUseFlow's finally). Register a fallback so a
      // stop/kill during the suspended window still tears this down instead
      // of ExecutionRegistry.terminate() finding no interruptible context and
      // no-oping — see AgentRunLifecycle/ExecutionRegistry issue #7287.
      handle.registerWaitingCleanup(() => {
        ctx.session.followUps.release(streamId);
        void getExecutionStore(ctx.executionId)
          .delete(flowKey(ctx.executionId))
          .catch(() => {});
        // The kill path never resumes this run, so the per-suspension parent
        // stage opened by beginRunStage would otherwise dangle open forever.
        endParentStageSafely(
          ctx,
          agentIdentifier,
          legacyEndGroupStatusForOutcome(RUN_OUTCOME.CANCELLED),
        );
      });
      return result;
    }
    // The wait node may have pre-registered a suspension cleanup (via
    // onBeforeWaiting) on a turn that then continued past the wait instead of
    // suspending. This run is terminating normally, so drop any stale
    // registration before teardown unregisters the interrupt — otherwise
    // ExecutionRegistry.terminate() could mistake this handle for a suspended
    // one in the window between interrupt-unregister and untrack.
    handle.clearWaitingCleanup();
    // The flow's outcome is the canonical terminal fact; everything below is
    // one row of the projection table. No other layer may re-derive these.
    const projection = projectRunOutcome(result.outcome);
    await writeTerminalStatus(
      ctx.executionId,
      projection.executionStatus,
    ).catch(() => {});

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

    endParentStageSafely(
      ctx,
      agentIdentifier,
      legacyEndGroupStatusForOutcome(result.outcome),
    );
    // Emit the terminal result BEFORE untrack so the registry's terminal
    // listener event never precedes the result event, and settle the handle's
    // `result` promise with the same event (F-2: per-run control handle).
    handle.settleResult(
      emitRunResult(
        ctx,
        category,
        toResultOutcome(result.outcome),
        options?.isSubagent ?? false,
      ),
    );
    resultEmitted = true;
    try {
      await options?.onCompleted?.(result);
    } catch (deliveryError) {
      logger.warn('Completion hook failed', {
        data: { agentIdentifier, error: deliveryError },
      });
    }

    // The run has produced its canonical terminal result. Guard the terminal
    // cleanup so a throw from untrack's listeners or a stream-status host emit
    // cannot fall into the catch arm and publish a second `failed` result (or
    // re-throw) for an already-completed run.
    try {
      session.executions.untrack(ctx.executionId);
      if (
        !ctx.streamStatus.transitionToTerminal(streamId, result.outcome, {
          runtimeHost: ctx.runtimeHost,
          trace: ctx.logger,
        })
      ) {
        logger.warn('Failed to set terminal stream status', {
          data: { agentIdentifier, streamId, status: result.outcome },
        });
      }
    } catch (cleanupErr) {
      logger.warn('Post-completion cleanup threw', {
        data: { agentIdentifier, error: cleanupErr },
      });
    }
    logger.debug(`Task completed with outcome: ${result.outcome}`);
    return result;
  } catch (err) {
    // Same stale-registration guard as the success arm: an errored run is
    // not suspended, so no waiting-cleanup may survive into teardown.
    handle.clearWaitingCleanup();
    const kind = classifyAgentError(err);
    const outcome = AGENT_ERROR_OUTCOME[kind];
    const projection = projectRunOutcome(outcome);
    await writeTerminalStatus(
      ctx.executionId,
      projection.executionStatus,
    ).catch(() => {});
    // normalizeProviderError recovers the structured shape attached at the
    // flow-exit rethrows (T2-2) when one was attached, or formats a fresh one
    // otherwise; either way sdkMsg is unchanged from the prior getSdkErrorMessage
    // call (it reads the same .message). toRetryErrorInfo strips rawErrorBody —
    // the ResultEvent.error type omits it (bulky, not worth persisting) and a
    // bare object spread would silently smuggle it through past the type check.
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

    endParentStageSafely(
      ctx,
      agentIdentifier,
      legacyEndGroupStatusForOutcome(outcome),
    );
    // One emission covers all three exits below (subagent / abort / throw);
    // untrack follows in each branch, preserving emit-before-untrack. Outcome
    // routes through the same canonical mapper as the success arm
    // (`toResultOutcome(AGENT_ERROR_OUTCOME[kind])` — abort ⇒ `cancelled`, a
    // sibling of `failed`). Skipped when the success arm already emitted, so a
    // post-completion cleanup throw cannot double-publish.
    // Abort still carries the SDK message for event consumers; the toast mapper
    // intentionally suppresses user-facing notifications for aborts.
    if (!resultEmitted) {
      const message = kind === 'unexpected' ? errorMsg : sdkMsg;
      // `abort`/`disk-full` route through `formatProviderHttpError`'s
      // `terminalError()` branch, which never populates the provider/relay/
      // credential fields — narrow to the fields it actually sets so
      // `ResultEvent.error`'s per-kind union stays honest (see events.ts).
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
      handle.settleResult(
        emitRunResult(
          ctx,
          category,
          toResultOutcome(outcome),
          options?.isSubagent ?? false,
          error,
        ),
      );
    }
    try {
      if (
        !ctx.streamStatus.transitionToTerminal(streamId, outcome, {
          runtimeHost: ctx.runtimeHost,
          trace: ctx.logger,
        })
      ) {
        logger.warn('Failed to set terminal error status', {
          data: { agentIdentifier, streamId, status: outcome },
        });
      }
    } catch (statusErr) {
      logger.warn('Failed to set terminal error status', {
        data: { agentIdentifier, error: statusErr },
      });
    }
    // Terminal-error toasts are no longer emitted here: hosts present them from
    // the `result` event via `session.onResult` + `terminalResultToast` (the
    // single decision point). This keeps the run-lifecycle from owning host UI.

    if (options?.isSubagent) {
      const result =
        getAgentFlowErrorResult(err) ??
        buildTerminalFlowResult(
          category,
          outcome,
          ctx.executionId,
          streamId,
          ctx.attachedMemoryMisses,
        );
      try {
        await options.onError?.(err, result);
      } catch (deliveryError) {
        logger.warn('Failed to deliver subagent error', {
          data: { agentIdentifier, error: deliveryError },
        });
      }
      session.executions.untrack(ctx.executionId);
      return result;
    }

    session.executions.untrack(ctx.executionId);
    if (kind === 'abort') {
      return buildTerminalFlowResult(
        category,
        outcome,
        ctx.executionId,
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
