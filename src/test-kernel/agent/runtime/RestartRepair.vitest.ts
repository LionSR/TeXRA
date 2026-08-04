import { describe, expect, it, vi } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  repairRestartedStreams,
  RestartRepairRetryScheduler,
} from '@agent/runtime/restartRepair';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });

function seedRunning(
  streamStatus: StreamStatusMachine,
  streamId: StreamTabId,
): void {
  streamStatus.transition(
    streamId,
    STREAM_PHASE.RUNNING,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
}

function seedWaiting(
  streamStatus: StreamStatusMachine,
  streamId: StreamTabId,
): void {
  seedRunning(streamStatus, streamId);
  streamStatus.transition(
    streamId,
    STREAM_PHASE.WAITING,
    STREAM_TRANSITION_CAUSE.WAIT,
  );
}

function createDurableFinalizer() {
  return vi.fn(async () => ({
    status: 'durable' as const,
    outcomePersisted: true as const,
    flowRecord: 'deleted' as const,
  }));
}

/** Lease hook that treats the execution as inactive and runs the repair. */
async function performInactiveLease<T>(
  _executionId: ExecutionId,
  operation: () => Promise<T>,
): Promise<{ status: 'performed'; value: T }> {
  return { status: 'performed', value: await operation() };
}

/** Group closer that only reports closures for the expected outcome. */
function closeGroupsOn(expected: RunOutcome) {
  return vi.fn(async (streamIds: readonly StreamTabId[], status: RunOutcome) =>
    status === expected ? [...streamIds] : [],
  );
}

describe('repairRestartedStreams', () => {
  it('keeps only one delayed lease retry and cancels it on disposal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new RestartRepairRetryScheduler();
    const superseded = vi.fn();
    const retry = vi.fn();
    const disposed = vi.fn();

    try {
      scheduler.schedule(1_010, superseded);
      scheduler.schedule(1_020, retry);
      vi.advanceTimersByTime(19);
      expect(superseded).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(retry).toHaveBeenCalledOnce();

      scheduler.schedule(1_030, disposed);
      scheduler.dispose();
      vi.advanceTimersByTime(10);
      expect(disposed).not.toHaveBeenCalled();

      const rearmedAfterDispose = vi.fn();
      scheduler.schedule(1_040, rearmedAfterDispose);
      vi.advanceTimersByTime(10);
      expect(rearmedAfterDispose).not.toHaveBeenCalled();
    } finally {
      scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it('skips every repair mutation for a fresh foreign lease', async () => {
    const streamId = 'stream-foreign-active' as StreamTabId;
    const executionId = 'execution-foreign-active' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = vi.fn(async () => [] as StreamTabId[]);
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups,
      finalizeExecution,
      runWithInactiveExecutionLease: vi.fn(async () => ({
        status: 'active' as const,
        heartbeatAt: 123,
      })),
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(result).toEqual({
      waitingStreams: [],
      failedStreams: [],
      closedWaitingGroups: [],
      closedFailedGroups: [],
      terminalStatusUpdated: [],
      nextLeaseCheckAt: 120_124,
    });
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('preserves an execution that completed before a delayed lease retry', async () => {
    const streamId = 'stream-completed-before-retry' as StreamTabId;
    const executionId = 'execution-completed-before-retry' as ExecutionId;
    const store = getExecutionStore(executionId);
    await store.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
      outcome: RUN_OUTCOME.COMPLETED,
    });
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = vi.fn(async () => [] as StreamTabId[]);
    const finalizeExecution = createDurableFinalizer();

    try {
      const result = await repairRestartedStreams({
        streamStatus,
        waitingStreams: new Set(),
        executionIds: new Map([[streamId, executionId]]),
        closeRunningGroups,
        finalizeExecution,
        runWithInactiveExecutionLease: performInactiveLease,
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
      await expect(store.readMeta()).resolves.toMatchObject({
        terminalStatus: EXECUTION_STATUS.COMPLETED,
        outcome: RUN_OUTCOME.COMPLETED,
      });
      expect(result.failedStreams).toEqual([]);
      expect(closeRunningGroups).toHaveBeenCalledWith(
        [streamId],
        RUN_OUTCOME.COMPLETED,
        expect.any(Number),
      );
      expect(finalizeExecution).not.toHaveBeenCalled();
    } finally {
      await store.clear();
    }
  });

  it('propagates settlement metadata read failures', async () => {
    const streamId = 'stream-unreadable-settlement' as StreamTabId;
    const executionId = 'execution-unreadable-settlement' as ExecutionId;
    const store = getExecutionStore(executionId);
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const readMetaStrict = vi
      .spyOn(store, 'readMetaStrict')
      .mockRejectedValue(new Error('metadata temporarily unreadable'));

    try {
      await expect(
        repairRestartedStreams({
          streamStatus,
          waitingStreams: new Set(),
          executionIds: new Map([[streamId, executionId]]),
          closeRunningGroups: vi.fn(async () => []),
          runWithInactiveExecutionLease: performInactiveLease,
        }),
      ).rejects.toThrow('metadata temporarily unreadable');
      expect(readMetaStrict).toHaveBeenCalledOnce();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    } finally {
      readMetaStrict.mockRestore();
      await store.clear();
    }
  });

  it('protects an unknown legacy terminal state from restart repair', async () => {
    const streamId = 'stream-legacy-terminal' as StreamTabId;
    const executionId = 'execution-legacy-terminal' as ExecutionId;
    const store = getExecutionStore(executionId);
    await store.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
      terminalStatus: 'legacy-terminal',
    });
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = vi.fn(async () => [streamId]);
    const finalizeExecution = createDurableFinalizer();

    try {
      const result = await repairRestartedStreams({
        streamStatus,
        waitingStreams: new Set(),
        executionIds: new Map([[streamId, executionId]]),
        closeRunningGroups,
        finalizeExecution,
        runWithInactiveExecutionLease: performInactiveLease,
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
      expect(closeRunningGroups).not.toHaveBeenCalled();
      expect(result.failedStreams).toEqual([]);
      const persistedMeta = await store.readMeta();
      expect(persistedMeta).toMatchObject({
        terminalStatus: 'legacy-terminal',
      });
      expect(persistedMeta?.outcome).toBeUndefined();
      expect(finalizeExecution).not.toHaveBeenCalled();
    } finally {
      await store.clear();
    }
  });

  it('repairs resumable running streams to WAITING with neutral group closure', async () => {
    const streamId = 'stream-waiting' as StreamTabId;
    const executionId = 'execution-waiting' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set([streamId]),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups,
      finalizeExecution,
      now: 123,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(result).toMatchObject({
      waitingStreams: [streamId],
      failedStreams: [],
      closedWaitingGroups: [streamId],
      closedFailedGroups: [],
      terminalStatusUpdated: [],
    });
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      123,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('repairs resumable streams without an in-memory phase and closes their groups', async () => {
    const streamId = 'stream-waiting-without-phase' as StreamTabId;
    const executionId = 'execution-waiting-without-phase' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set([streamId]),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
      now: 234,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(result.closedWaitingGroups).toEqual([streamId]);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      234,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('closes non-waiting candidates without an in-memory phase without terminalizing them', async () => {
    const streamId = 'stream-without-phase' as StreamTabId;
    const executionId = 'execution-without-phase' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.FAILED);
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
      now: 345,
    });

    expect(streamStatus.get(streamId)).toBeUndefined();
    expect(result).toMatchObject({
      waitingStreams: [],
      failedStreams: [],
      closedWaitingGroups: [],
      closedFailedGroups: [streamId],
      terminalStatusUpdated: [],
    });
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.FAILED,
      345,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('closes waiting groups even when the current phase is not repairable', async () => {
    const streamId = 'stream-terminal-waiting' as StreamTabId;
    const executionId = 'execution-terminal-waiting' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    streamStatus.transition(
      streamId,
      STREAM_PHASE.CANCELLED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set([streamId]),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
      now: 456,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(result).toMatchObject({
      waitingStreams: [],
      failedStreams: [],
      closedWaitingGroups: [streamId],
      closedFailedGroups: [],
      terminalStatusUpdated: [],
    });
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      456,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('repairs non-resumable running streams to FAILED and writes terminal meta', async () => {
    const streamId = 'stream-failed' as StreamTabId;
    const executionId = 'execution-failed' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.FAILED);
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups,
      finalizeExecution,
      now: 456,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(result).toMatchObject({
      waitingStreams: [],
      failedStreams: [streamId],
      closedWaitingGroups: [],
      closedFailedGroups: [streamId],
      terminalStatusUpdated: [executionId],
    });
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.FAILED,
      456,
    );
    expect(finalizeExecution).toHaveBeenCalledWith({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });
  });

  it('does not write failed terminal meta before failed groups close', async () => {
    const streamId = 'stream-failed-close-error' as StreamTabId;
    const executionId = 'execution-failed-close-error' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const finalizeExecution = createDurableFinalizer();

    await expect(
      repairRestartedStreams({
        streamStatus,
        waitingStreams: new Set(),
        executionIds: new Map([[streamId, executionId]]),
        closeRunningGroups: async () => {
          throw new Error('group close failed');
        },
        finalizeExecution,
      }),
    ).rejects.toThrow('group close failed');

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('finishes one stream atomically when teardown begins during repair', async () => {
    const firstStream = 'stream-abort-first' as StreamTabId;
    const secondStream = 'stream-abort-second' as StreamTabId;
    const firstExecution = 'execution-abort-first' as ExecutionId;
    const secondExecution = 'execution-abort-second' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, firstStream);
    seedRunning(streamStatus, secondStream);
    const abort = new AbortController();
    const closeRunningGroups = vi.fn(async (streamIds: StreamTabId[]) => {
      abort.abort();
      return streamIds;
    });
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([
        [firstStream, firstExecution],
        [secondStream, secondExecution],
      ]),
      repairStreams: [firstStream, secondStream],
      closeRunningGroups,
      finalizeExecution,
      signal: abort.signal,
      runWithInactiveExecutionLease: performInactiveLease,
    });

    expect(streamStatus.get(firstStream)).toBe(STREAM_PHASE.FAILED);
    expect(finalizeExecution).toHaveBeenCalledWith({
      executionId: firstExecution,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });
    expect(result.failedStreams).toEqual([firstStream]);
    expect(streamStatus.get(secondStream)).toBe(STREAM_PHASE.RUNNING);
    expect(finalizeExecution).toHaveBeenCalledOnce();
  });

  it('writes failed terminal meta when retrying an already failed repair', async () => {
    const streamId = 'stream-failed-retry' as StreamTabId;
    const executionId = 'execution-failed-retry' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const finalizeExecution = createDurableFinalizer();

    await expect(
      repairRestartedStreams({
        streamStatus,
        waitingStreams: new Set(),
        executionIds: new Map([[streamId, executionId]]),
        closeRunningGroups: async () => {
          throw new Error('group close failed');
        },
        finalizeExecution,
      }),
    ).rejects.toThrow('group close failed');
    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(finalizeExecution).not.toHaveBeenCalled();

    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.FAILED);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      retryFailedStreams: true,
      closeRunningGroups,
      finalizeExecution,
      now: 567,
    });

    expect(result).toMatchObject({
      failedStreams: [streamId],
      closedFailedGroups: [streamId],
      terminalStatusUpdated: [executionId],
    });
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.FAILED,
      567,
    );
    expect(finalizeExecution).toHaveBeenCalledWith({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });
  });

  it('does not retry historical failed streams unless retry is requested', async () => {
    const streamId = 'stream-historical-failed' as StreamTabId;
    const executionId = 'execution-historical-failed' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    streamStatus.transition(
      streamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[]) => [...streamIds],
    );
    const finalizeExecution = createDurableFinalizer();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(result).toMatchObject({
      failedStreams: [],
      closedFailedGroups: [],
      terminalStatusUpdated: [],
    });
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('does not report terminal status when metadata persistence fails', async () => {
    const streamId = 'stream-metadata-failure' as StreamTabId;
    const executionId = 'execution-metadata-failure' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const durabilityError = new Error('metadata disk write failed');
    const finalizeExecution = vi.fn(async () => ({
      status: 'failed' as const,
      stage: 'terminal-status' as const,
      outcomePersisted: false as const,
      error: durabilityError,
    }));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups: async (streamIds) => [...streamIds],
      finalizeExecution,
      logger,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(result.terminalStatusUpdated).toEqual([]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Failed to finalize restart-repair execution',
      {
        data: {
          streamId,
          executionId,
          stage: 'terminal-status',
          outcomePersisted: false,
          error: durabilityError,
        },
      },
    );
  });

  it('reports flow cleanup failure but keeps durable terminal metadata', async () => {
    const streamId = 'stream-flow-delete-failure' as StreamTabId;
    const executionId = 'execution-flow-delete-failure' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);
    const cleanupError = new Error('flow delete failed');
    const finalizeExecution = vi.fn(async () => ({
      status: 'failed' as const,
      stage: 'flow-record-delete' as const,
      outcomePersisted: true as const,
      error: cleanupError,
    }));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups: async (streamIds) => [...streamIds],
      finalizeExecution,
      logger,
    });

    expect(result.terminalStatusUpdated).toEqual([executionId]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Failed to finalize restart-repair execution',
      {
        data: {
          streamId,
          executionId,
          stage: 'flow-record-delete',
          outcomePersisted: true,
          error: cleanupError,
        },
      },
    );
  });

  it('can terminalize stale WAITING streams through the resume choreography', async () => {
    const streamId = 'stream-stale-waiting' as StreamTabId;
    const executionId = 'execution-stale-waiting' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedWaiting(streamStatus, streamId);

    await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups: async (streamIds) => [...streamIds],
      finalizeExecution: createDurableFinalizer(),
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
  });

  it('writes failed execution metadata that supersedes an interim result', async () => {
    const streamId = 'stream-real-meta' as StreamTabId;
    const executionId = 'execution-real-meta' as ExecutionId;
    const store = getExecutionStore(executionId);
    await store.writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      description: 'keep this field',
    });
    await store.writeResultMeta({
      producer: 'subagent',
      agentName: 'restart-repair-agent',
      wallTimeMs: 1,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'interim response',
        files: [],
        cost: 0,
      },
    });
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    seedRunning(streamStatus, streamId);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups: async () => [],
    });

    const repairedMeta = await store.readMeta();
    expect(repairedMeta).toMatchObject({
      description: 'keep this field',
      outcome: RUN_OUTCOME.FAILED,
    });
    expect(repairedMeta?.terminalStatus).toBeUndefined();
    await expect(store.readResultMeta()).resolves.toMatchObject({
      result: {
        outcome: RUN_OUTCOME.FAILED,
        response: 'interim response',
      },
    });
    expect(result.terminalStatusUpdated).toEqual([executionId]);
  });
});
