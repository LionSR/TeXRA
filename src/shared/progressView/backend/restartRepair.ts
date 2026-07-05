import { writeTerminalStatus as defaultWriteTerminalStatus } from '@agent/storage/executionLifecycle';
import type {
  StreamStatusEmitOptions,
  StreamStatusMachine,
} from '@agent/runtime/StreamStatusService';
import {
  projectRunOutcome,
  STREAM_TRANSITION_CAUSE,
} from '@common/constants/streamStatus';
import {
  END_GROUP_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  type EndGroupStatus,
  type ExecutionId,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';

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
    status: EndGroupStatus,
    now: number,
  ): Promise<readonly StreamTabId[]>;
  repairStreams?: Iterable<StreamTabId>;
  statusEmitOptions?: StreamStatusEmitOptions;
  writeTerminalStatus?: (
    executionId: ExecutionId,
    status: string,
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
  writeTerminalStatus: (
    executionId: ExecutionId,
    status: string,
  ) => Promise<void>,
  logger: RestartRepairLogger | undefined,
): Promise<ExecutionId[]> {
  const status = projectRunOutcome(RUN_OUTCOME.FAILED).executionStatus;
  const writes = streamIds.flatMap((streamId) => {
    const executionId = executionIds.get(streamId);
    return executionId ? [{ streamId, executionId }] : [];
  });
  const results = await Promise.allSettled(
    writes.map(({ executionId }) => writeTerminalStatus(executionId, status)),
  );

  const updated: ExecutionId[] = [];
  for (const [index, result] of results.entries()) {
    const { streamId, executionId } = writes[index];
    if (result.status === 'fulfilled') {
      updated.push(executionId);
      continue;
    }
    logger?.warn('Failed to persist restart-repair terminal status', {
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

    if (currentStatus === STREAM_PHASE.FAILED && !isWaitingStream) {
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
  const closedWaitingGroups =
    waitingGroupStreams.length > 0
      ? await options.closeRunningGroups(
          waitingGroupStreams,
          END_GROUP_STATUS.STOPPED,
          now,
        )
      : [];
  const closedFailedGroups =
    failedGroupStreams.length > 0
      ? await options.closeRunningGroups(
          failedGroupStreams,
          END_GROUP_STATUS.ERROR,
          now,
        )
      : [];
  const terminalStatusUpdated = await writeFailedTerminalStatuses(
    failedStreams,
    options.executionIds,
    options.writeTerminalStatus ?? defaultWriteTerminalStatus,
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
