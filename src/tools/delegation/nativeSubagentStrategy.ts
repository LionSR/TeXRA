/**
 * Native subagent callback strategy.
 *
 * This packages the async `executeAgent` callback choreography used by native
 * delegated agents. The strategy owns child result delivery across WAITING
 * turns: progress/interim/terminal follow-ups, manifest writes, duplicate
 * delivery gating, WAITING resume, and registry cleanup.
 */

// Local imports - agent
import { getExecutionStore, type ResultMeta } from '@agent/storage';
import {
  isWaitingFlowResult,
  type AgentFlowResult,
  type AgentRuntimeFlowResult,
} from '@agent/runtime/AgentFlowResult';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { resumeQueuedToolUseSnapshot } from '@agent/runtime/resumeQueuedToolUse';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunHandle } from '@agent/runtime/executionRegistry';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import {
  wakeQueuedFollowUpStream,
  type FollowUpWakeResult,
  type SendFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - tools
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  deliverChildRunFollowUp,
  deliverTerminalChildRun,
  persistChildRunReport,
  persistChildRunResultMeta,
  type ChildRunTerminalDeliveryResult,
} from '@tools/childRunDelivery';
import {
  buildSubagentFailureResultMeta,
  buildSubagentResultMeta,
  formatSubagentDelivery,
  formatSubagentError,
  formatSubagentProgress,
} from '@tools/subagentResults';
import {
  SUBAGENT_DELIVERY_DECISION,
  SharedSubagentDeliveryRegistry,
} from '@tools/subagentDeliveryState';
import {
  computeAndWriteWorkflowDiffs,
  type DiffFileInfo,
} from '@tools/subagentDiffs';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { ToolEditApprovalPort } from '@platform/interfaces/toolEditApproval';

export interface NativeSubagentStrategyParams {
  readonly executionId: ExecutionId;
  readonly agentName: string;
  readonly orchestratorStreamId: StreamTabId;
  readonly parentSession: SessionHandle;
  readonly runtimeHost: AgentRuntimeHost;
  readonly startedAt: number;
  readonly workingDirectory?: string;
  readonly settleSubagentCost: (result?: AgentFlowResult) => void;
}

export interface NativeSubagentResumeOptions {
  readonly approvalPromptsUnavailable?: boolean;
  readonly runtimeUnavailableTools?: readonly string[];
  readonly toolEditApprovalHandler?: ToolEditApprovalPort;
}

const activeNativeSubagents = new Map<string, NativeSubagentStrategy>();

export function getNativeSubagentStrategy(
  executionId: string,
): NativeSubagentStrategy | undefined {
  return activeNativeSubagents.get(executionId);
}

/**
 * Format a subagent result for delivery to the orchestrator.
 * For workflow results, computes latexdiffs and writes them as files to the
 * execution's run directory first — the delivery references diff file paths
 * so the orchestrator can read them on demand via /executions/{id}/files/.
 */
export async function subagentDeliveryMessage(
  executionId: ExecutionId,
  agentName: string,
  result: AgentFlowResult,
  options: {
    readonly startedAt: number;
    readonly workingDirectory?: string;
  },
): Promise<{ msg: string; resultMeta: ResultMeta }> {
  let diffInfos: Map<string, DiffFileInfo> | undefined;
  let diffsUnavailable: string | undefined;
  if (result.category === 'workflow' && result.outputs.length > 0) {
    try {
      diffInfos = await computeAndWriteWorkflowDiffs(
        executionId,
        result.outputs,
      );
    } catch (err) {
      // Diff computation failure is non-fatal: deliver without diffs, but tell
      // the orchestrator to read the output files directly.
      diffsUnavailable = toErrorMessage(err);
      logger.warn(
        'subagentDelivery',
        `Diff computation failed for ${executionId}: ${diffsUnavailable}`,
      );
    }
  }

  const wallTimeMs = Date.now() - options.startedAt;
  return {
    msg: formatSubagentDelivery(agentName, result, {
      diffInfos,
      diffsUnavailable,
      wallTimeMs,
      workingDirectory: options.workingDirectory,
    }),
    resultMeta: buildSubagentResultMeta(agentName, result, {
      diffInfos,
      diffsUnavailable,
      wallTimeMs,
    }),
  };
}

export async function writeSubagentReport(
  executionId: ExecutionId,
  message: string,
): Promise<void> {
  const result = await persistChildRunReport(executionId, message);
  if (result.kind === 'failed') {
    // Non-fatal, but the report is the only durable copy of the result when
    // delivery later fails.
    logger.warn(
      'subagentDelivery',
      `Failed to persist subagent report for ${executionId}: ${toErrorMessage(result.err)}`,
    );
  }
}

/**
 * Best-effort persist of the structured result manifest — the chaining
 * contract read via /executions/{id}/result. Never blocks or fails delivery.
 */
export async function writeSubagentResultMeta(
  executionId: ExecutionId,
  resultMeta: ResultMeta,
): Promise<void> {
  const result = await persistChildRunResultMeta(executionId, resultMeta);
  if (result.kind === 'failed') {
    logger.warn(
      'subagentDelivery',
      `Failed to persist subagent result manifest for ${executionId}: ${toErrorMessage(result.err)}`,
    );
  }
}

export class NativeSubagentStrategy {
  private readonly deliveryState;
  private childStreamId: StreamTabId | undefined;
  private runHandle: AgentRunHandle | undefined;
  private readonly detachAbandonListener: () => void;
  /**
   * Most recent run-cost snapshot observed while suspending at WAITING. Used
   * by `abandon()` to roll a suspended-then-stopped subagent's spend into the
   * parent's usage totals, since that path never reaches `onCompleted`/`onError`.
   */
  private lastKnownCostUsd: number | undefined;

  constructor(private readonly params: NativeSubagentStrategyParams) {
    this.deliveryState = SharedSubagentDeliveryRegistry.start(
      params.executionId,
    );
    activeNativeSubagents.set(params.executionId, this);
    // Backstop for an abandoned WAITING session: a native subagent that
    // suspends and is never resumed and never errors has no other terminal
    // event to drive `finish()`. Piggyback on the execution registry's own
    // abandonment signal — the same "handle goes undefined" terminal
    // notification `ExecutionRegistry.addListener` already fires on untrack
    // (explicit stop, cascade from a stopped orchestrator, or session
    // teardown/dispose) — rather than inventing a second, time-based
    // channel that could fire while the execution is still legitimately
    // resumable.
    this.detachAbandonListener = params.parentSession.executions.addListener(
      params.executionId,
      (handle) => {
        if (handle === undefined) this.finish();
      },
    );
  }

  setChildStreamId(streamId: StreamTabId): void {
    this.childStreamId = streamId;
  }

  setRunHandle(handle: AgentRunHandle): void {
    this.runHandle = handle;
    this.childStreamId = handle.childStreamId;
  }

  async deliverFollowUp(
    followUp: FollowUpQueueInput,
    options?: { wake?: boolean },
  ): Promise<boolean> {
    const { executionId, orchestratorStreamId, parentSession } = this.params;
    const targetStreamId = this.runHandle
      ? this.runHandle.deliveryTargetStreamId
      : orchestratorStreamId;
    if (!targetStreamId) return false;

    const result = await deliverChildRunFollowUp({
      targetStreamId,
      followUp,
      session: parentSession,
      wake: options?.wake,
    });
    if (result.kind === 'no_session') {
      logger.warn(
        'subagentDelivery',
        `Unable to deliver subagent result for ${executionId}: parent stream ${targetStreamId} has no active session (status: ${result.streamStatus ?? 'unknown'}).`,
      );
      return false;
    }
    if (result.kind === 'dropped') {
      logger.warn(
        'subagentDelivery',
        `Dropped subagent result for ${executionId}: parent stream ${targetStreamId} is gone and could not be resumed. The result remains in the execution report.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Deliver a terminal result and persist its report and manifest. The manifest
   * lands before wake because the parent can immediately read
   * /executions/{id}/result after the follow-up arrives.
   */
  async persistAndDeliverTerminal(
    msg: string,
    resultMeta?: ResultMeta,
  ): Promise<boolean> {
    const { executionId, parentSession } = this.params;
    const targetStreamId = this.runHandle
      ? this.runHandle.deliveryTargetStreamId
      : this.params.orchestratorStreamId;
    const result = await deliverTerminalChildRun({
      executionId,
      message: msg,
      resultMeta,
      targetStreamId,
      session: parentSession,
      gate: this.deliveryState,
    });
    this.warnTerminalDeliveryResult(result, targetStreamId);
    return result.kind === 'delivered';
  }

  private warnTerminalDeliveryResult(
    result: ChildRunTerminalDeliveryResult,
    targetStreamId: StreamTabId | undefined,
  ): void {
    const { executionId } = this.params;
    if (result.resultMeta.kind === 'failed') {
      logger.warn(
        'subagentDelivery',
        `Failed to persist subagent result manifest for ${executionId}: ${toErrorMessage(result.resultMeta.err)}`,
      );
    }
    if (result.report.kind === 'failed') {
      // Non-fatal, but the report is the only durable copy of the result when
      // delivery later fails.
      logger.warn(
        'subagentDelivery',
        `Failed to persist subagent report for ${executionId}: ${toErrorMessage(result.report.err)}`,
      );
    }
    if (result.kind === 'no_session') {
      logger.warn(
        'subagentDelivery',
        `Unable to deliver subagent result for ${executionId}: parent stream ${targetStreamId ?? 'unknown'} has no active session (status: ${result.streamStatus ?? 'unknown'}).`,
      );
      return;
    }
    if (result.kind === 'dropped') {
      logger.warn(
        'subagentDelivery',
        `Dropped subagent result for ${executionId}: parent stream ${targetStreamId ?? 'unknown'} is gone and could not be resumed. The result remains in the execution report.`,
      );
    }
  }

  onProgress(update: SubagentProgressUpdate): void {
    if (this.deliveryState.isDelivered()) return;
    const msg = formatSubagentProgress(
      this.params.executionId,
      this.params.agentName,
      update,
    );
    void this.deliverFollowUp({ text: msg, origin: 'subagent_result' });
  }

  onFollowUpConsumed(): void {
    this.deliveryState.markPending();
  }

  async wakeQueuedFollowUp(
    result: SendFollowUpResult,
    options: NativeSubagentResumeOptions,
  ): Promise<FollowUpWakeResult> {
    const streamId = this.childStreamId;
    if (!streamId) return { kind: 'queued_resume_failed' };
    try {
      return await wakeQueuedFollowUpStream(
        streamId,
        result,
        {
          tryResumeStream: (id) => this.resumeStream(id, options),
        },
        this.params.parentSession,
      );
    } catch (err) {
      // DelegationTools dispatches this wake fire-and-forget (see #7289), so a
      // rejection here has nowhere else to surface. It can happen before
      // `resumeStream` ever reaches `resumeQueuedToolUseSnapshot` — e.g.
      // `retrieveSessionResumeData` throwing on unreadable resume storage —
      // i.e. before this turn's onError/onRunError callbacks are installed.
      // Route it through the same terminal error-delivery path a resumed
      // turn's own onError takes, instead of leaving the caller's
      // `logger.warn` as the only observable outcome: the orchestrator was
      // told the follow-up "will process it automatically" and needs a real
      // delivery, not silence.
      try {
        // deliverSubagentError has no result to settle cost from here (the
        // wake never reached a real turn), so roll in the most recent cost
        // snapshot captured before suspending — same fallback abandon() uses
        // for the same reason. settleSubagentCost is idempotent (first call
        // wins), so deliverSubagentError's own no-result settle below is a
        // no-op once this has already recorded the real spend.
        if (this.lastKnownCostUsd !== undefined) {
          this.params.settleSubagentCost({
            category: 'toolUse',
            outcome: RUN_OUTCOME.CANCELLED,
            executionId: this.params.executionId,
            streamId: this.childStreamId ?? this.params.orchestratorStreamId,
            totalCostUsd: this.lastKnownCostUsd,
          });
        }
        await this.deliverSubagentError(err);
      } finally {
        this.finish();
      }
      return { kind: 'queued_resume_failed' };
    }
  }

  private async resumeStream(
    streamId: StreamTabId,
    options: NativeSubagentResumeOptions,
  ): Promise<boolean> {
    if (streamId !== this.childStreamId) return false;
    const config = await getExecutionStore(
      this.params.executionId,
    ).readConfig();
    if (!config) return false;

    const resume = await retrieveSessionResumeData(
      streamId,
      this.params.executionId,
      config,
    );
    if (!resume || resume.type !== 'toolUse') return false;

    return await resumeQueuedToolUseSnapshot(
      streamId,
      resume.snapshot,
      this.params.runtimeHost,
      {
        session: this.params.parentSession,
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        runtimeUnavailableTools: options.runtimeUnavailableTools,
        toolEditApprovalHandler: options.toolEditApprovalHandler,
        parentStreamId: this.params.orchestratorStreamId,
        allowWaitingResult: true,
        onProgress: (update) => this.onProgress(update),
        onFollowUpConsumed: () => this.onFollowUpConsumed(),
        onBeforeWaiting: (
          lastResponse,
          touchedFiles,
          memoryMisses,
          totalCostUsd,
        ) =>
          this.onBeforeWaiting(
            lastResponse,
            touchedFiles,
            memoryMisses,
            totalCostUsd,
          ),
        // `finish()` runs in `finally` in each hook below: `resumeQueuedToolUseSnapshot`
        // and `runFlowWithLifecycle` only log and swallow a throw from these
        // callbacks (they never propagate it back here), so a `this.finish()`
        // placed after the `await` would silently never run on failure,
        // stranding this strategy's registry entries for a run that
        // `runFlowWithLifecycle` already considers untracked.
        onCompleted: async (result) => {
          try {
            await this.onCompleted(result);
          } finally {
            this.finish();
          }
        },
        onRunError: async (err, result) => {
          try {
            await this.onError(err, result);
          } finally {
            this.finish();
          }
        },
        onError: async (err) => {
          try {
            await this.deliverSubagentError(err);
          } finally {
            this.finish();
          }
        },
        onRun: (handle) => this.setRunHandle(handle),
      },
    );
  }

  async onBeforeWaiting(
    lastResponse: string | undefined,
    touchedFiles: string[],
    memoryMisses: readonly AttachedMemoryMiss[],
    totalCostUsd?: number,
  ): Promise<boolean> {
    if (totalCostUsd !== undefined) {
      this.lastKnownCostUsd = totalCostUsd;
    }
    // `onBeforeWaiting` fires before every *potential* WAITING suspension of
    // a native subagent — the initial launch and every later resume alike,
    // each with its own `runHandle` (see `setRunHandle` / `resumeStream`).
    // The flow may still continue past the wait (a follow-up raced into the
    // queue), in which case the run lifecycle clears this pre-registration on
    // its terminal path (`clearWaitingCleanup`), so a non-suspended run never
    // carries a stale abandon into teardown. Registering here, rather than
    // only once on the initial launch promise, is what makes a stop/kill
    // during a *second* (or later) suspended turn still run this strategy's
    // own teardown instead of leaving `activeNativeSubagents`/the delivery
    // registry pointing at a removed execution (see `abandon()`). Belt and
    // suspenders: `ExecutionRegistry.terminateWaitingHandle` independently
    // requires `streamStatus` to actually be WAITING before treating a
    // registered cleanup as safe to run, so even a stale registration this
    // clearing missed (a future non-waiting exit that forgets to call
    // `clearWaitingCleanup`) can't cause an incorrect abandon.
    this.runHandle?.registerWaitingCleanup(() => this.abandon());

    const deliveryDecision = this.deliveryState.resolveBeforeWaiting(
      this.childStreamId,
    );
    if (deliveryDecision === SUBAGENT_DELIVERY_DECISION.AlreadyDelivered) {
      return true;
    }
    if (deliveryDecision === SUBAGENT_DELIVERY_DECISION.MissingStream) {
      return false;
    }
    const resolvedChildStreamId = this.childStreamId;
    if (!resolvedChildStreamId) return false;

    const { executionId, agentName, startedAt, workingDirectory } = this.params;
    const interimResult = {
      category: 'toolUse' as const,
      // The turn finished and the subagent is entering WAITING — for the
      // orchestrator this interim delivery is a completed turn.
      outcome: 'completed' as const,
      lastResponse,
      touchedFiles,
      executionId,
      streamId: resolvedChildStreamId,
      memoryMisses: memoryMisses.length > 0 ? [...memoryMisses] : undefined,
    };
    const wallTimeMs = Date.now() - startedAt;
    const msg = formatSubagentDelivery(agentName, interimResult, {
      wallTimeMs,
      workingDirectory,
    });
    // Claim only the enqueue step: formatting failures before this still leave
    // onCompleted/onError available as terminal fallbacks.
    return await this.persistAndDeliverTerminal(
      msg,
      buildSubagentResultMeta(agentName, interimResult, { wallTimeMs }),
    );
  }

  async onCompleted(result: AgentFlowResult): Promise<void> {
    this.params.settleSubagentCost(result);
    const { msg, resultMeta } = await subagentDeliveryMessage(
      this.params.executionId,
      this.params.agentName,
      result,
      {
        startedAt: this.params.startedAt,
        workingDirectory: this.params.workingDirectory,
      },
    );
    await this.persistAndDeliverTerminal(msg, resultMeta);
  }

  async deliverSubagentError(
    err: unknown,
    result?: AgentFlowResult,
  ): Promise<void> {
    this.params.settleSubagentCost(result);
    const { executionId, agentName, startedAt, workingDirectory } = this.params;
    const wallTimeMs = Date.now() - startedAt;
    const msg = formatSubagentError(executionId, agentName, err, {
      wallTimeMs,
      workingDirectory,
      memoryMisses: result?.memoryMisses,
    });
    // Overwrite any interim success manifest from onBeforeWaiting so
    // /executions/{id}/result never claims success for a failed run.
    await this.persistAndDeliverTerminal(
      msg,
      buildSubagentFailureResultMeta(agentName, result, wallTimeMs),
    );
  }

  onError(err: unknown, result?: AgentFlowResult): Promise<void> {
    return this.deliverSubagentError(err, result);
  }

  private finish(): void {
    this.detachAbandonListener();
    SharedSubagentDeliveryRegistry.finish(this.params.executionId);
    activeNativeSubagents.delete(this.params.executionId);
  }

  /**
   * Tear down this strategy's tracking state without delivering anything.
   * Registered as a WAITING-suspend cleanup on every turn's `runHandle` (see
   * `onBeforeWaiting`) — initial launch and every later resume alike — so a
   * stop/kill of a suspended child, on any turn, doesn't leave
   * `activeNativeSubagents`/the delivery registry pointing at a gone
   * execution. Also settles the parent's usage totals with the most recent
   * cost snapshot observed before suspending, since this path never reaches
   * `onCompleted`/`onError`.
   */
  abandon(): void {
    if (this.lastKnownCostUsd !== undefined) {
      this.params.settleSubagentCost({
        category: 'toolUse',
        outcome: RUN_OUTCOME.CANCELLED,
        executionId: this.params.executionId,
        streamId: this.childStreamId ?? this.params.orchestratorStreamId,
        totalCostUsd: this.lastKnownCostUsd,
      });
    }
    this.finish();
  }

  attachPromise(promise: Promise<unknown>): void {
    let suspended = false;
    promise
      .then((result: unknown) => {
        if (isWaitingFlowResult(result as AgentRuntimeFlowResult)) {
          // Only reachable once the flow genuinely suspended (not a
          // near-miss cycle that kept running in-process). The abandon
          // cleanup itself is registered from `onBeforeWaiting`, which fires
          // immediately before this on every suspending turn (initial launch
          // and each resume) — this flag only needs to know a suspend
          // happened so `.finally()` below skips the normal-completion
          // teardown.
          suspended = true;
        }
      })
      // Await the error delivery so the registry entry is not torn down while
      // the delivery and any resume-based follow-up routing are in flight.
      .catch((err: unknown) => this.deliverSubagentError(err))
      .catch((deliveryErr: unknown) => {
        logger.warn(
          'subagentDelivery',
          `Failed to deliver subagent error for ${this.params.executionId}: ${toErrorMessage(deliveryErr)}`,
        );
      })
      .finally(() => {
        if (!suspended) {
          this.finish();
        }
      });
  }
}
