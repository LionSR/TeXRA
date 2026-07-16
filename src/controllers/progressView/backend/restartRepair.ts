import {
  finalizeExecution as defaultFinalizeExecution,
  synchronizeAgentResultOutcome as defaultSynchronizeResultOutcome,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
} from '@agent/storage/executionLifecycle';
import {
  EXECUTION_LEASE_STALE_MS,
  runWithInactiveExecutionLease as defaultRunWithInactiveExecutionLease,
} from '@agent/storage/executionLease';
import { executionIdFromStream } from '@agent/storage/executionIdFromStream';
import type {
  StreamStatusEmitOptions,
  StreamStatusMachine,
} from '@agent/runtime/StreamStatusService';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type RunOutcome,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import {
  projectRunOutcome,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';

interface RestartRepairLogger {
  debug(message: string): void;
  warn(message: string, context?: { data?: unknown }): void;
}

export interface RestartRepairOptions {
  streamStatus: StreamStatusMachine;
  waitingStreams: ReadonlySet<StreamTabId>;
  executionIds: ReadonlyMap<StreamTabId, ExecutionId>;
  closeRunningGroups(
    streamIds: readonly StreamTabId[],
    status: RunOutcome,
    now: number,
  ): Promise<readonly StreamTabId[]>;
  repairStreams?: Iterable<StreamTabId>;
  /** Retry terminal metadata after an earlier repair already moved a stream to FAILED. */
  retryFailedStreams?: boolean;
  statusEmitOptions?: StreamStatusEmitOptions;
  finalizeExecution?: (
    input: FinalizeExecutionInput,
  ) => Promise<FinalizeExecutionResult>;
  /** Align the latest persisted envelope after terminal metadata is durable. */
  synchronizeResultOutcome?: (
    executionId: ExecutionId,
    outcome: RunOutcome,
  ) => Promise<void>;
  /** Serialize liveness validation and repair mutations with acquisition. */
  runWithInactiveExecutionLease?: <T>(
    executionId: ExecutionId,
    operation: () => Promise<T>,
  ) => Promise<
    | { readonly status: 'active'; readonly heartbeatAt: number }
    | { readonly status: 'performed'; readonly value: T }
  >;
  logger?: RestartRepairLogger;
  now?: number;
}

export interface RestartRepairResult {
  waitingStreams: StreamTabId[];
  failedStreams: StreamTabId[];
  closedWaitingGroups: StreamTabId[];
  closedFailedGroups: StreamTabId[];
  terminalStatusUpdated: ExecutionId[];
  /** Earliest time a fresh lease skipped at startup can be checked again. */
  nextLeaseCheckAt?: number;
}

/** Owns the single delayed retry used to revisit leases left fresh by a crash. */
export class RestartRepairRetryScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;

  schedule(nextLeaseCheckAt: number | undefined, retry: () => void): void {
    this.cancel();
    if (nextLeaseCheckAt === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        retry();
      },
      Math.max(0, nextLeaseCheckAt - Date.now()),
    );
    this.timer.unref();
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export const RESTART_REPAIR_PHASES: ReadonlySet<StreamPhase> = new Set([
  STREAM_PHASE.RUNNING,
  STREAM_PHASE.WAITING,
]);

function repairCandidates(
  streamStatus: StreamStatusMachine,
  repairStreams?: Iterable<StreamTabId>,
): StreamTabId[] {
  if (repairStreams) return [...repairStreams];
  return [...streamStatus.entries()]
    .filter(([, phase]) => phase === STREAM_PHASE.RUNNING)
    .map(([streamId]) => streamId);
}

/** Repair one stream back to WAITING, logging the outcome. */
function repairToWaiting(
  streamStatus: StreamStatusMachine,
  streamId: StreamTabId,
  statusEmitOptions: StreamStatusEmitOptions | undefined,
  logger: RestartRepairLogger | undefined,
): boolean {
  if (
    streamStatus.transition(
      streamId,
      STREAM_PHASE.WAITING,
      STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
      statusEmitOptions,
    )
  ) {
    logger?.debug(`Stream ${streamId} restored to WAITING after restart`);
    return true;
  }
  logger?.warn(`Failed to repair stream ${streamId} to WAITING after restart`);
  return false;
}

function transitionToFailedForRestart(
  streamStatus: StreamStatusMachine,
  streamId: StreamTabId,
  currentStatus: StreamPhase | undefined,
  statusEmitOptions: StreamStatusEmitOptions | undefined,
): boolean {
  if (
    streamStatus.transition(
      streamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
      statusEmitOptions,
    )
  ) {
    return true;
  }
  if (currentStatus !== STREAM_PHASE.WAITING) return false;
  return (
    streamStatus.transition(
      streamId,
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.RESUME,
      statusEmitOptions,
    ) &&
    streamStatus.transition(
      streamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
      statusEmitOptions,
    )
  );
}

async function writeFailedTerminalStatuses(
  streamIds: readonly StreamTabId[],
  executionIds: ReadonlyMap<StreamTabId, ExecutionId>,
  finalizeExecution: (
    input: FinalizeExecutionInput,
  ) => Promise<FinalizeExecutionResult>,
  synchronizeResultOutcome: (
    executionId: ExecutionId,
    outcome: RunOutcome,
  ) => Promise<void>,
  logger: RestartRepairLogger | undefined,
): Promise<ExecutionId[]> {
  const status = projectRunOutcome(RUN_OUTCOME.FAILED).executionStatus;
  const writes = streamIds.flatMap((streamId) => {
    const executionId = executionIds.get(streamId);
    return executionId ? [{ streamId, executionId }] : [];
  });
  const results = await Promise.allSettled(
    writes.map(({ executionId }) =>
      finalizeExecution({
        executionId,
        terminalStatus: status,
        flowRecord: 'delete',
      }),
    ),
  );

  const updated: ExecutionId[] = [];
  const synchronizationWrites: Array<{
    streamId: StreamTabId;
    executionId: ExecutionId;
  }> = [];
  for (const [index, result] of results.entries()) {
    const { streamId, executionId } = writes[index];
    if (result.status === 'fulfilled') {
      const finalization = result.value;
      if (finalization.status === 'failed') {
        logger?.warn('Failed to finalize restart-repair execution', {
          data: {
            streamId,
            executionId,
            stage: finalization.stage,
            terminalStatusPersisted: finalization.terminalStatusPersisted,
            error: finalization.error,
          },
        });
      }
      if (finalization.terminalStatusPersisted) {
        updated.push(executionId);
        synchronizationWrites.push({ streamId, executionId });
      }
      continue;
    }
    logger?.warn('Restart-repair finalization rejected unexpectedly', {
      data: { streamId, executionId, error: result.reason },
    });
  }

  const synchronizationResults = await Promise.allSettled(
    synchronizationWrites.map(({ executionId }) =>
      synchronizeResultOutcome(executionId, RUN_OUTCOME.FAILED),
    ),
  );
  for (const [index, result] of synchronizationResults.entries()) {
    if (result.status === 'fulfilled') continue;
    const { streamId, executionId } = synchronizationWrites[index];
    logger?.warn('Failed to align restart-repair result outcome', {
      data: { streamId, executionId, error: result.reason },
    });
  }
  return updated;
}

/**
 * Shared restart repair owner for extension and desktop hosts.
 *
 * Hosts still supply host-specific facts (waiting detection, active-run race
 * guards, restored desktop streams), but this function owns the writes that
 * must stay consistent: stream status, transcript group closure, and terminal
 * execution metadata for failed repairs.
 */
export async function repairRestartedStreams(
  options: RestartRepairOptions,
): Promise<RestartRepairResult> {
  const result: RestartRepairResult = {
    waitingStreams: [],
    failedStreams: [],
    closedWaitingGroups: [],
    closedFailedGroups: [],
    terminalStatusUpdated: [],
  };
  const now = options.now ?? Date.now();

  for (const streamId of repairCandidates(
    options.streamStatus,
    options.repairStreams,
  )) {
    const executionId =
      options.executionIds.get(streamId) ?? executionIdFromStream(streamId);
    let repairStarted = false;
    try {
      const repair = () => {
        repairStarted = true;
        return repairRestartedStream(options, streamId, executionId, now);
      };
      const repaired = executionId
        ? await (
            options.runWithInactiveExecutionLease ??
            defaultRunWithInactiveExecutionLease
          )(executionId, repair)
        : { status: 'performed' as const, value: await repair() };
      if (repaired.status === 'active') {
        const nextLeaseCheckAt =
          repaired.heartbeatAt + EXECUTION_LEASE_STALE_MS + 1;
        result.nextLeaseCheckAt = Math.min(
          result.nextLeaseCheckAt ?? Number.POSITIVE_INFINITY,
          nextLeaseCheckAt,
        );
        options.logger?.debug(
          `Skipped restart repair for active execution ${executionId}`,
        );
        continue;
      }
      result.waitingStreams.push(...repaired.value.waitingStreams);
      result.failedStreams.push(...repaired.value.failedStreams);
      result.closedWaitingGroups.push(...repaired.value.closedWaitingGroups);
      result.closedFailedGroups.push(...repaired.value.closedFailedGroups);
      result.terminalStatusUpdated.push(
        ...repaired.value.terminalStatusUpdated,
      );
    } catch (error) {
      if (repairStarted) throw error;
      options.logger?.warn(
        `Skipped restart repair for execution ${executionId ?? streamId} because its lease or repair state could not be validated`,
        { data: error },
      );
    }
  }
  return result;
}

async function repairRestartedStream(
  options: RestartRepairOptions,
  streamId: StreamTabId,
  executionId: ExecutionId | undefined,
  now: number,
): Promise<RestartRepairResult> {
  const waitingStreams: StreamTabId[] = [];
  const failedStreams: StreamTabId[] = [];
  const waitingGroupStreams: StreamTabId[] = [];
  const failedGroupStreams: StreamTabId[] = [];
  const currentStatus = options.streamStatus.get(streamId);
  const isWaitingStream = options.waitingStreams.has(streamId);

  if (currentStatus == null) {
    if (isWaitingStream) {
      waitingGroupStreams.push(streamId);
      if (
        repairToWaiting(
          options.streamStatus,
          streamId,
          options.statusEmitOptions,
          options.logger,
        )
      ) {
        waitingStreams.push(streamId);
      }
    } else {
      failedGroupStreams.push(streamId);
    }
  } else if (
    options.retryFailedStreams === true &&
    currentStatus === STREAM_PHASE.FAILED &&
    !isWaitingStream
  ) {
    failedStreams.push(streamId);
    failedGroupStreams.push(streamId);
  } else if (!RESTART_REPAIR_PHASES.has(currentStatus)) {
    if (isWaitingStream) waitingGroupStreams.push(streamId);
  } else if (isWaitingStream) {
    waitingGroupStreams.push(streamId);
    if (
      repairToWaiting(
        options.streamStatus,
        streamId,
        options.statusEmitOptions,
        options.logger,
      )
    ) {
      waitingStreams.push(streamId);
    }
  } else if (
    transitionToFailedForRestart(
      options.streamStatus,
      streamId,
      currentStatus,
      options.statusEmitOptions,
    )
  ) {
    failedStreams.push(streamId);
    failedGroupStreams.push(streamId);
    options.logger?.debug(
      `Stream ${streamId} set to FAILED during restart repair`,
    );
  } else {
    options.logger?.warn(`Failed to repair stream ${streamId} after restart`);
  }

  const closedWaitingGroups = waitingGroupStreams.length
    ? await options.closeRunningGroups(
        waitingGroupStreams,
        RUN_OUTCOME.CANCELLED,
        now,
      )
    : [];
  const closedFailedGroups = failedGroupStreams.length
    ? await options.closeRunningGroups(
        failedGroupStreams,
        RUN_OUTCOME.FAILED,
        now,
      )
    : [];
  const terminalStatusUpdated = await writeFailedTerminalStatuses(
    failedStreams,
    executionId
      ? new Map<StreamTabId, ExecutionId>([[streamId, executionId]])
      : options.executionIds,
    options.finalizeExecution ?? defaultFinalizeExecution,
    options.synchronizeResultOutcome ?? defaultSynchronizeResultOutcome,
    options.logger,
  );
  return {
    waitingStreams,
    failedStreams,
    closedWaitingGroups: [...closedWaitingGroups],
    closedFailedGroups: [...closedFailedGroups],
    terminalStatusUpdated,
  };
}
