import { describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { getExecutionStore } from '@agent/storage';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { STREAM_TRANSITION_CAUSE } from '@common/constants/streamStatus';
import {
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  type EndGroupStatus,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { repairRestartedStreams } from '@shared/progressView/backend/restartRepair';

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

describe('repairRestartedStreams', () => {
  it('repairs resumable running streams to WAITING with neutral group closure', async () => {
    const streamId = 'stream-waiting' as StreamTabId;
    const executionId = 'execution-waiting' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: EndGroupStatus) =>
        status === END_GROUP_STATUS.STOPPED ? [...streamIds] : [],
    );
    const writeTerminalStatus = vi.fn();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set([streamId]),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups,
      writeTerminalStatus,
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
      END_GROUP_STATUS.STOPPED,
      123,
    );
    expect(writeTerminalStatus).not.toHaveBeenCalled();
  });

  it('repairs resumable streams without an in-memory phase and closes their groups', async () => {
    const streamId = 'stream-waiting-without-phase' as StreamTabId;
    const executionId = 'execution-waiting-without-phase' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: EndGroupStatus) =>
        status === END_GROUP_STATUS.STOPPED ? [...streamIds] : [],
    );
    const writeTerminalStatus = vi.fn();

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set([streamId]),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      writeTerminalStatus,
      now: 234,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(result.closedWaitingGroups).toEqual([streamId]);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      END_GROUP_STATUS.STOPPED,
      234,
    );
    expect(writeTerminalStatus).not.toHaveBeenCalled();
  });

  it('closes non-waiting candidates without an in-memory phase without terminalizing them', async () => {
    const streamId = 'stream-without-phase' as StreamTabId;
    const executionId = 'execution-without-phase' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: EndGroupStatus) =>
        status === END_GROUP_STATUS.ERROR ? [...streamIds] : [],
    );
    const writeTerminalStatus = vi.fn(async () => undefined);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      writeTerminalStatus,
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
      END_GROUP_STATUS.ERROR,
      345,
    );
    expect(writeTerminalStatus).not.toHaveBeenCalled();
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
      async (streamIds: readonly StreamTabId[], status: EndGroupStatus) =>
        status === END_GROUP_STATUS.STOPPED ? [...streamIds] : [],
    );
    const writeTerminalStatus = vi.fn(async () => undefined);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set([streamId]),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      writeTerminalStatus,
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
      END_GROUP_STATUS.STOPPED,
      456,
    );
    expect(writeTerminalStatus).not.toHaveBeenCalled();
  });

  it('repairs non-resumable running streams to FAILED and writes terminal meta', async () => {
    const streamId = 'stream-failed' as StreamTabId;
    const executionId = 'execution-failed' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: EndGroupStatus) =>
        status === END_GROUP_STATUS.ERROR ? [...streamIds] : [],
    );
    const writeTerminalStatus = vi.fn(async () => undefined);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      closeRunningGroups,
      writeTerminalStatus,
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
      END_GROUP_STATUS.ERROR,
      456,
    );
    expect(writeTerminalStatus).toHaveBeenCalledWith(
      executionId,
      EXECUTION_STATUS.ERROR,
    );
  });

  it('does not write failed terminal meta before failed groups close', async () => {
    const streamId = 'stream-failed-close-error' as StreamTabId;
    const executionId = 'execution-failed-close-error' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const writeTerminalStatus = vi.fn(async () => undefined);

    await expect(
      repairRestartedStreams({
        streamStatus,
        waitingStreams: new Set(),
        executionIds: new Map([[streamId, executionId]]),
        closeRunningGroups: async () => {
          throw new Error('group close failed');
        },
        writeTerminalStatus,
      }),
    ).rejects.toThrow('group close failed');

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(writeTerminalStatus).not.toHaveBeenCalled();
  });

  it('writes failed terminal meta when retrying an already failed repair', async () => {
    const streamId = 'stream-failed-retry' as StreamTabId;
    const executionId = 'execution-failed-retry' as ExecutionId;
    const streamStatus = new StreamStatusMachine();
    seedRunning(streamStatus, streamId);
    const writeTerminalStatus = vi.fn(async () => undefined);

    await expect(
      repairRestartedStreams({
        streamStatus,
        waitingStreams: new Set(),
        executionIds: new Map([[streamId, executionId]]),
        closeRunningGroups: async () => {
          throw new Error('group close failed');
        },
        writeTerminalStatus,
      }),
    ).rejects.toThrow('group close failed');
    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(writeTerminalStatus).not.toHaveBeenCalled();

    const closeRunningGroups = vi.fn(
      async (streamIds: readonly StreamTabId[], status: EndGroupStatus) =>
        status === END_GROUP_STATUS.ERROR ? [...streamIds] : [],
    );

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      retryFailedStreams: true,
      closeRunningGroups,
      writeTerminalStatus,
      now: 567,
    });

    expect(result).toMatchObject({
      failedStreams: [streamId],
      closedFailedGroups: [streamId],
      terminalStatusUpdated: [executionId],
    });
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      END_GROUP_STATUS.ERROR,
      567,
    );
    expect(writeTerminalStatus).toHaveBeenCalledWith(
      executionId,
      EXECUTION_STATUS.ERROR,
    );
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
    const writeTerminalStatus = vi.fn(async () => undefined);

    const result = await repairRestartedStreams({
      streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([[streamId, executionId]]),
      repairStreams: [streamId],
      closeRunningGroups,
      writeTerminalStatus,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(result).toMatchObject({
      failedStreams: [],
      closedFailedGroups: [],
      terminalStatusUpdated: [],
    });
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(writeTerminalStatus).not.toHaveBeenCalled();
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
      writeTerminalStatus: vi.fn(async () => undefined),
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
    expect(result.terminalStatusUpdated).toEqual([executionId]);
  });
});
