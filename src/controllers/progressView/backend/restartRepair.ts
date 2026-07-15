import {
  finalizeExecution as defaultFinalizeExecution,
  synchronizeAgentResultOutcome as defaultSynchronizeResultOutcome,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
} from '@agent/storage/executionLifecycle';
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
  logger?: RestartRepairLogger;
  now?: number;
}

export interface RestartRepairResult {
  waitingStreams: StreamTabId[];
  failedStreams: StreamTabId[];
  closedWaitingGroups: StreamTabId[];
  closedFailedGroups: StreamTabId[];
  terminalStatusUpdated: ExecutionId[];
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
  const waitingStreams: StreamTabId[] = [];
  const failedStreams: StreamTabId[] = [];
  const waitingGroupStreams: StreamTabId[] = [];
  const orphanedGroupStreams: StreamTabId[] = [];

  for (const streamId of repairCandidates(
    options.streamStatus,
    options.repairStreams,
  )) {
    const currentStatus = options.streamStatus.get(streamId);
    const isWaitingStream = options.waitingStreams.has(streamId);

    if (currentStatus == null) {
      if (isWaitingStream) {
        waitingGroupStreams.push(streamId);
        if (
          options.streamStatus.transition(
            streamId,
            STREAM_PHASE.WAITING,
            STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
            options.statusEmitOptions,
          )
        ) {
          waitingStreams.push(streamId);
          options.logger?.debug(
            `Stream ${streamId} restored to WAITING after restart`,
          );
        } else {
          options.logger?.warn(
            `Failed to repair stream ${streamId} to WAITING after restart`,
          );
        }
      } else {
        orphanedGroupStreams.push(streamId);
      }
      continue;
    }

    if (
      options.retryFailedStreams === true &&
      currentStatus === STREAM_PHASE.FAILED &&
      !isWaitingStream
    ) {
      failedStreams.push(streamId);
      continue;
    }

    if (!RESTART_REPAIR_PHASES.has(currentStatus)) {
      if (isWaitingStream) {
        waitingGroupStreams.push(streamId);
      }
      continue;
    }

    if (isWaitingStream) {
      waitingGroupStreams.push(streamId);
      if (
        options.streamStatus.transition(
          streamId,
          STREAM_PHASE.WAITING,
          STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
          options.statusEmitOptions,
        )
      ) {
        waitingStreams.push(streamId);
        options.logger?.debug(
          `Stream ${streamId} restored to WAITING after restart`,
        );
      } else {
        options.logger?.warn(
          `Failed to repair stream ${streamId} to WAITING after restart`,
        );
      }
      continue;
    }

    if (
      transitionToFailedForRestart(
        options.streamStatus,
        streamId,
        currentStatus,
        options.statusEmitOptions,
      )
    ) {
      failedStreams.push(streamId);
      options.logger?.debug(
        `Stream ${streamId} set to FAILED during restart repair`,
      );
    } else {
      options.logger?.warn(`Failed to repair stream ${streamId} after restart`);
    }
  }

  const now = options.now ?? Date.now();
  const failedGroupStreams = [...failedStreams, ...orphanedGroupStreams];
  // Restart repair's own crash-vs-graceful-interrupt classification (§8.2):
  // a stream repaired back to WAITING never crashed — it's a graceful
  // interrupt — so its still-open transcript group closes as CANCELLED, not
  // the unconditional error default a crash-classified stream gets below.
  const closedWaitingGroups =
    waitingGroupStreams.length > 0
      ? await options.closeRunningGroups(
          waitingGroupStreams,
          RUN_OUTCOME.CANCELLED,
          now,
        )
      : [];
  const closedFailedGroups =
    failedGroupStreams.length > 0
      ? await options.closeRunningGroups(
          failedGroupStreams,
          RUN_OUTCOME.FAILED,
          now,
        )
      : [];
  const terminalStatusUpdated = await writeFailedTerminalStatuses(
    failedStreams,
    options.executionIds,
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
