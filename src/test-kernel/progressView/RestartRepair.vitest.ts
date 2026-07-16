import { describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { repairRestartedStreams } from '@controllers/progressView/backend/restartRepair';
import { getExecutionStore } from '@agent/storage';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

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
    terminalStatusPersisted: true as const,
    flowRecord: 'deleted' as const,
  }));
}

describe('repairRestartedStreams', () => {
  it('skips every repair mutation for a fresh foreign lease', async () => {
    const streamId = 'stream-foreign-active' as StreamTabId;
    const executionId = 'execution-foreign-active' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
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
    });
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('repairs resumable running streams to WAITING with neutral group closure', async () => {
    const streamId = 'stream-waiting' as StreamTabId;
    const executionId = 'execution-waiting' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: RunOutcome) =>
        status === RUN_OUTCOME.CANCELLED ? [...streamIds] : [],
    );
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
    const streamStatus = new StreamStatusMachine();
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: RunOutcome) =>
        status === RUN_OUTCOME.CANCELLED ? [...streamIds] : [],
    );
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
    const streamStatus = new StreamStatusMachine();
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: RunOutcome) =>
        status === RUN_OUTCOME.FAILED ? [...streamIds] : [],
    );
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
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    streamStatus.transition(
      streamId,
      STREAM_PHASE.CANCELLED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: RunOutcome) =>
        status === RUN_OUTCOME.CANCELLED ? [...streamIds] : [],
    );
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
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: RunOutcome) =>
        status === RUN_OUTCOME.FAILED ? [...streamIds] : [],
    );
    const finalizeExecution = createDurableFinalizer();
    const synchronizeResultOutcome = vi.fn(async () => undefined);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups,
      finalizeExecution,
      synchronizeResultOutcome,
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
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });
    expect(synchronizeResultOutcome).toHaveBeenCalledWith(
      executionId,
      RUN_OUTCOME.FAILED,
    );
  });

  it('does not write failed terminal meta before failed groups close', async () => {
    const streamId = 'stream-failed-close-error' as StreamTabId;
    const executionId = 'execution-failed-close-error' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
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

  it('writes failed terminal meta when retrying an already failed repair', async () => {
    const streamId = 'stream-failed-retry' as StreamTabId;
    const executionId = 'execution-failed-retry' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
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

    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: RunOutcome) =>
        status === RUN_OUTCOME.FAILED ? [...streamIds] : [],
    );

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
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });
  });

  it('does not retry historical failed streams unless retry is requested', async () => {
    const streamId = 'stream-historical-failed' as StreamTabId;
    const executionId = 'execution-historical-failed' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
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

  it('does not report or synchronize terminal status when metadata persistence fails', async () => {
    const streamId = 'stream-metadata-failure' as StreamTabId;
    const executionId = 'execution-metadata-failure' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const durabilityError = new Error('metadata disk write failed');
    const finalizeExecution = vi.fn(async () => ({
      status: 'failed' as const,
      stage: 'terminal-status' as const,
      terminalStatusPersisted: false as const,
      error: durabilityError,
    }));
    const synchronizeResultOutcome = vi.fn(async () => undefined);
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups: async (streamIds) => [...streamIds],
      finalizeExecution,
      synchronizeResultOutcome,
      logger,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(result.terminalStatusUpdated).toEqual([]);
    expect(synchronizeResultOutcome).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Failed to finalize restart-repair execution',
      {
        data: {
          streamId,
          executionId,
          stage: 'terminal-status',
          terminalStatusPersisted: false,
          error: durabilityError,
        },
      },
    );
  });

  it('reports flow cleanup failure but synchronizes durable terminal metadata', async () => {
    const streamId = 'stream-flow-delete-failure' as StreamTabId;
    const executionId = 'execution-flow-delete-failure' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const cleanupError = new Error('flow delete failed');
    const finalizeExecution = vi.fn(async () => ({
      status: 'failed' as const,
      stage: 'flow-record-delete' as const,
      terminalStatusPersisted: true as const,
      error: cleanupError,
    }));
    const synchronizeResultOutcome = vi.fn(async () => undefined);
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups: async (streamIds) => [...streamIds],
      finalizeExecution,
      synchronizeResultOutcome,
      logger,
    });

    expect(result.terminalStatusUpdated).toEqual([executionId]);
    expect(synchronizeResultOutcome).toHaveBeenCalledExactlyOnceWith(
      executionId,
      RUN_OUTCOME.FAILED,
    );
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Failed to finalize restart-repair execution',
      {
        data: {
          streamId,
          executionId,
          stage: 'flow-record-delete',
          terminalStatusPersisted: true,
          error: cleanupError,
        },
      },
    );
  });

  it('can terminalize stale WAITING streams through the resume choreography', async () => {
    const streamId = 'stream-stale-waiting' as StreamTabId;
    const executionId = 'execution-stale-waiting' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
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

  it('writes failed execution metadata through the default lifecycle hook', async () => {
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
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups: async () => [],
    });

    await expect(store.readMeta()).resolves.toMatchObject({
      description: 'keep this field',
      terminalStatus: EXECUTION_STATUS.ERROR,
      outcome: RUN_OUTCOME.FAILED,
    });
    await expect(store.readResultMeta()).resolves.toMatchObject({
      result: {
        outcome: RUN_OUTCOME.FAILED,
        response: 'interim response',
      },
    });
    expect(result.terminalStatusUpdated).toEqual([executionId]);
  });
});
