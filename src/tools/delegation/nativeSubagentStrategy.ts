/**
 * Native subagent callback strategy.
 *
 * This packages the async `executeAgent` callback choreography used by native
 * delegated agents. It does not run the child loop itself; `executeSubagent`
 * still calls `executeAgent` directly. The strategy owns only delivery policy
 * for native child results: progress/interim/terminal follow-ups, manifest
 * writes, duplicate-delivery gating, and registry cleanup.
 */

// Local imports - agent
import { getExecutionStore, type ResultMeta } from '@agent/storage';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunHandle } from '@agent/runtime/executionRegistry';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - tools
import type {
  ExecutionId,
  StreamTabId,
  SubagentProgressUpdate,
} from '@shared/schemas';
import {
  deliverChildRunFollowUp,
  persistChildRunReport,
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
  subagentDeliveryRegistry,
} from '@tools/subagentDeliveryState';
import {
  computeAndWriteWorkflowDiffs,
  type DiffFileInfo,
} from '@tools/subagentDiffs';
import { toErrorMessage } from '@utils/errors/errorMessage';

export interface NativeSubagentStrategyParams {
  readonly executionId: ExecutionId;
  readonly agentName: string;
  readonly orchestratorStreamId: StreamTabId;
  readonly parentSession: SessionHandle;
  readonly startedAt: number;
  readonly workingDirectory?: string;
  readonly settleSubagentCost: (result?: AgentFlowResult) => void;
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
  try {
    await getExecutionStore(executionId).writeResultMeta(resultMeta);
  } catch (err) {
    logger.warn(
      'subagentDelivery',
      `Failed to persist subagent result manifest for ${executionId}: ${toErrorMessage(err)}`,
    );
  }
}

export class NativeSubagentStrategy {
  private readonly deliveryState;
  private childStreamId: StreamTabId | undefined;
  private runHandle: AgentRunHandle | undefined;

  constructor(private readonly params: NativeSubagentStrategyParams) {
    this.deliveryState = subagentDeliveryRegistry.start(params.executionId);
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

  async deliverTerminalFollowUp(
    followUp: FollowUpQueueInput,
  ): Promise<boolean> {
    if (!this.deliveryState.beginDelivery()) return false;
    try {
      const delivered = await this.deliverFollowUp(followUp, { wake: true });
      if (delivered) {
        this.deliveryState.completeDelivery();
      } else {
        this.deliveryState.failDelivery();
      }
      return delivered;
    } catch (err) {
      this.deliveryState.failDelivery();
      throw err;
    }
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
    const { executionId } = this.params;
    if (resultMeta) {
      await writeSubagentResultMeta(executionId, resultMeta);
    }
    const [delivered] = await Promise.all([
      this.deliverTerminalFollowUp({ text: msg, origin: 'subagent_result' }),
      writeSubagentReport(executionId, msg),
    ]);
    return delivered;
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

  async onBeforeWaiting(
    lastResponse: string | undefined,
    touchedFiles: string[],
    memoryMisses: readonly AttachedMemoryMiss[],
  ): Promise<boolean> {
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

  attachPromise(promise: Promise<unknown>): void {
    promise
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
        subagentDeliveryRegistry.finish(this.params.executionId);
      });
  }
}
