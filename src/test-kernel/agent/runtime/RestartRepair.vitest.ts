import { describe, expect, it, vi } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  repairRestartedStreams,
  type RestartRepairOptions,
} from '@agent/runtime/restartRepair';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });

interface StreamSetup {
  streamId: StreamTabId;
  executionId: ExecutionId;
  streamStatus: StreamStatusMachine;
}

function setupStream(name: string): StreamSetup {
  return {
    streamId: `stream-${name}` as StreamTabId,
    executionId: `execution-${name}` as ExecutionId,
    streamStatus: new StreamStatusMachine(new SessionEventHub()),
  };
}

function setupRunningStream(name: string): StreamSetup {
  const setup = setupStream(name);
  seedRunning(setup.streamStatus, setup.streamId);
  return setup;
}

function runRepair(
  setup: StreamSetup,
  overrides: Partial<RestartRepairOptions> &
    Pick<RestartRepairOptions, 'closeRunningGroups'>,
) {
  return repairRestartedStreams({
    streamStatus: setup.streamStatus,
    waitingStreams: new Set(),
    executionIds: new Map([[setup.streamId, setup.executionId]]),
    ...overrides,
  });
}

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

async function closeAllGroups(
  streamIds: readonly StreamTabId[],
): Promise<StreamTabId[]> {
  return [...streamIds];
}

async function failGroupClose(): Promise<StreamTabId[]> {
  throw new Error('group close failed');
}

describe('repairRestartedStreams', () => {
  it('skips every repair mutation for a live foreign owner', async () => {
    const setup = setupRunningStream('foreign-active');
    const closeRunningGroups = vi.fn(async () => [] as StreamTabId[]);
    const finalizeExecution = createDurableFinalizer();
    const owner = {
      instanceId: 'test-instance',
      socketPath: '/tmp/texra-test.sock',
      pid: 1,
      hostname: 'test-host',
    };

    const result = await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution,
      runWithInactiveExecutionLease: vi.fn(async () => ({
        status: 'active' as const,
        owner,
      })),
    });

    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(result).toEqual({
      activeOwners: [
        { streamId: setup.streamId, executionId: setup.executionId, owner },
      ],
    });
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('probes one shared active owner once per repair pass', async () => {
    const first = setupRunningStream('shared-owner-first');
    const second = setupRunningStream('shared-owner-second');
    const owner = {
      instanceId: 'shared-instance',
      socketPath: '/tmp/texra-shared.sock',
      pid: 1,
      hostname: 'test-host',
    };
    const probeOwner = vi.fn(async () => 'alive' as const);
    const runWithInactiveExecutionLease = vi.fn(
      async (_executionId, _operation, leaseOptions) => {
        expect(await leaseOptions?.probeOwner?.(owner)).toBe('alive');
        return { status: 'active' as const, owner };
      },
    );

    const result = await repairRestartedStreams({
      streamStatus: first.streamStatus,
      waitingStreams: new Set(),
      executionIds: new Map([
        [first.streamId, first.executionId],
        [second.streamId, second.executionId],
      ]),
      repairStreams: [first.streamId, second.streamId],
      closeRunningGroups: vi.fn(async () => [] as StreamTabId[]),
      probeOwner,
      runWithInactiveExecutionLease,
    });

    expect(probeOwner).toHaveBeenCalledOnce();
    expect(result.activeOwners).toHaveLength(2);
  });

  it('preserves an execution that completed before a delayed lease retry', async () => {
    const setup = setupRunningStream('completed-before-retry');
    const { streamId, executionId, streamStatus } = setup;
    const store = getExecutionStore(executionId);
    await store.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
      outcome: RUN_OUTCOME.COMPLETED,
    });
    const closeRunningGroups = vi.fn(async () => [] as StreamTabId[]);
    const finalizeExecution = createDurableFinalizer();

    try {
      await runRepair(setup, {
        closeRunningGroups,
        finalizeExecution,
        runWithInactiveExecutionLease: performInactiveLease,
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
      await expect(store.readMeta()).resolves.toMatchObject({
        outcome: RUN_OUTCOME.COMPLETED,
      });
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
    const setup = setupRunningStream('unreadable-settlement');
    const store = getExecutionStore(setup.executionId);
    const readMetaStrict = vi
      .spyOn(store, 'readMetaStrict')
      .mockRejectedValue(new Error('metadata temporarily unreadable'));

    try {
      await expect(
        runRepair(setup, {
          closeRunningGroups: closeAllGroups,
          runWithInactiveExecutionLease: performInactiveLease,
        }),
      ).rejects.toThrow('metadata temporarily unreadable');
      expect(readMetaStrict).toHaveBeenCalledOnce();
      expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.RUNNING);
    } finally {
      readMetaStrict.mockRestore();
      await store.clear();
    }
  });

  it('repairs resumable running streams to WAITING with neutral group closure', async () => {
    const setup = setupRunningStream('waiting');
    const { streamId, streamStatus } = setup;
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      waitingStreams: new Set([streamId]),
      closeRunningGroups,
      finalizeExecution,
      now: 123,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      123,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('repairs resumable streams without an in-memory phase and closes their groups', async () => {
    const setup = setupStream('waiting-without-phase');
    const { streamId, streamStatus } = setup;
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      waitingStreams: new Set([streamId]),
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
      now: 234,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      234,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('closes non-waiting candidates without an in-memory phase without terminalizing them', async () => {
    const setup = setupStream('without-phase');
    const { streamId, streamStatus } = setup;
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.FAILED);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
      now: 345,
    });

    expect(streamStatus.get(streamId)).toBeUndefined();
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.FAILED,
      345,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('closes waiting groups even when the current phase is not repairable', async () => {
    const setup = setupRunningStream('terminal-waiting');
    const { streamId, streamStatus } = setup;
    streamStatus.transition(
      streamId,
      STREAM_PHASE.CANCELLED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      waitingStreams: new Set([streamId]),
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
      now: 456,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      456,
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('repairs non-resumable running streams to FAILED and writes terminal meta', async () => {
    const setup = setupRunningStream('failed');
    const { streamId, executionId, streamStatus } = setup;
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.FAILED);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution,
      now: 456,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
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
    const setup = setupRunningStream('failed-close-error');
    const finalizeExecution = createDurableFinalizer();

    await expect(
      runRepair(setup, {
        closeRunningGroups: failGroupClose,
        finalizeExecution,
      }),
    ).rejects.toThrow('group close failed');

    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.FAILED);
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

    await repairRestartedStreams({
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
    expect(streamStatus.get(secondStream)).toBe(STREAM_PHASE.RUNNING);
    expect(finalizeExecution).toHaveBeenCalledOnce();
  });

  it('writes failed terminal meta when retrying an already failed repair', async () => {
    const setup = setupRunningStream('failed-retry');
    const { streamId, executionId, streamStatus } = setup;
    const finalizeExecution = createDurableFinalizer();

    await expect(
      runRepair(setup, {
        closeRunningGroups: failGroupClose,
        finalizeExecution,
      }),
    ).rejects.toThrow('group close failed');
    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(finalizeExecution).not.toHaveBeenCalled();

    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.FAILED);

    await runRepair(setup, {
      repairStreams: [streamId],
      retryFailedStreams: true,
      closeRunningGroups,
      finalizeExecution,
      now: 567,
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
    const setup = setupRunningStream('historical-failed');
    const { streamId, streamStatus } = setup;
    streamStatus.transition(
      streamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    const closeRunningGroups = vi.fn(closeAllGroups);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      repairStreams: [streamId],
      closeRunningGroups,
      finalizeExecution,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('does not report terminal status when metadata persistence fails', async () => {
    const setup = setupRunningStream('metadata-failure');
    const { streamId, executionId, streamStatus } = setup;
    const durabilityError = new Error('metadata disk write failed');
    const finalizeExecution = vi.fn(async () => ({
      status: 'failed' as const,
      stage: 'terminal-status' as const,
      outcomePersisted: false as const,
      error: durabilityError,
    }));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await runRepair(setup, {
      closeRunningGroups: closeAllGroups,
      finalizeExecution,
      logger,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
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
    const setup = setupRunningStream('flow-delete-failure');
    const { streamId, executionId } = setup;
    const cleanupError = new Error('flow delete failed');
    const finalizeExecution = vi.fn(async () => ({
      status: 'failed' as const,
      stage: 'flow-record-delete' as const,
      outcomePersisted: true as const,
      error: cleanupError,
    }));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await runRepair(setup, {
      closeRunningGroups: closeAllGroups,
      finalizeExecution,
      logger,
    });

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
    const setup = setupStream('stale-waiting');
    seedWaiting(setup.streamStatus, setup.streamId);

    await runRepair(setup, {
      repairStreams: [setup.streamId],
      closeRunningGroups: closeAllGroups,
      finalizeExecution: createDurableFinalizer(),
    });

    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.FAILED);
  });

  it('writes failed execution metadata that supersedes an interim result', async () => {
    const setup = setupRunningStream('real-meta');
    const { executionId } = setup;
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

    await runRepair(setup, {
      closeRunningGroups: async () => [],
    });

    const repairedMeta = await store.readMeta();
    expect(repairedMeta).toMatchObject({
      description: 'keep this field',
      outcome: RUN_OUTCOME.FAILED,
    });
    await expect(store.readResultMeta()).resolves.toMatchObject({
      result: {
        outcome: RUN_OUTCOME.FAILED,
        response: 'interim response',
      },
    });
  });
});
