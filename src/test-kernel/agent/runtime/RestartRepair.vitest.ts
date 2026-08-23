import { describe, expect, it, vi } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import {
  RESUMABILITY_CAUSE,
  type ResumabilityDecision,
} from '@agent/storage/resumability';
import type { RunClassification } from '@agent/runtime/runClassification';
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
import {
  streamHeldMessage,
  streamUnreadableMessage,
} from '@shared/streams/streamStatusDisplay';
import { setupPlatform } from '@test/support/setupPlatform';

const LIVE_OWNER = { pid: 1, processStart: '1', hostname: 'test-host' };

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

/**
 * The durable facts that would have produced `classification`: what the
 * settlement re-reads under the lease. Ownership-only kinds have no facts;
 * settlement never reaches them.
 */
function factsFor(classification: RunClassification): ResumabilityDecision {
  switch (classification.kind) {
    case 'resumable':
      return {
        resumable: true,
        cause: RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW,
        flowRecord: {} as FlowRecord,
        outcome: classification.outcome,
      };
    case 'finished':
      return {
        resumable: false,
        cause: RESUMABILITY_CAUSE.MISSING_FLOW,
        outcome: classification.outcome,
      };
    case 'unclassified':
      return { resumable: false, cause: RESUMABILITY_CAUSE.UNREADABLE_META };
    case 'held_elsewhere':
    case 'owned_here':
      throw new Error(`no durable facts for ${classification.kind}`);
  }
}

function runRepair(
  setup: StreamSetup,
  overrides: Partial<RestartRepairOptions> &
    Pick<RestartRepairOptions, 'closeRunningGroups'>,
) {
  const classifyRun = overrides.classifyRun;
  return repairRestartedStreams({
    streamStatus: setup.streamStatus,
    repairStreams: [setup.streamId],
    executionIds: new Map([[setup.streamId, setup.executionId]]),
    // Settlement re-reads the facts under the lease; by default they agree
    // with the pre-claim classification.
    deriveResumability: classifyRun
      ? async (executionId) => factsFor(await classifyRun(executionId))
      : undefined,
    ...overrides,
  });
}

function classifyAs(classification: RunClassification) {
  return vi.fn(async () => classification);
}

function createDurableFinalizer() {
  return vi.fn(async () => ({
    status: 'durable' as const,
    outcomePersisted: true as const,
    flowRecord: 'preserved' as const,
  }));
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
  it('marks a stream held by a live foreign owner and mutates nothing', async () => {
    const setup = setupStream('foreign-active');
    const closeRunningGroups = vi.fn(async () => [] as StreamTabId[]);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution,
      classifyRun: classifyAs({ kind: 'held_elsewhere', owner: LIVE_OWNER }),
    });

    expect(setup.streamStatus.get(setup.streamId)).toBeUndefined();
    expect(setup.streamStatus.holdState(setup.streamId)).toBe(
      streamHeldMessage(LIVE_OWNER),
    );
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('releases a held mark once the stream settles on a later pass', async () => {
    const setup = setupStream('held-then-settled');
    setup.streamStatus.markUnavailable(
      setup.streamId,
      streamHeldMessage(LIVE_OWNER),
    );

    await runRepair(setup, {
      closeRunningGroups: closeAllGroups,
      finalizeExecution: createDurableFinalizer(),
      classifyRun: classifyAs({ kind: 'resumable' }),
    });

    expect(setup.streamStatus.holdState(setup.streamId)).toBeUndefined();
    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.CANCELLED);

    // A hold overlaid on an already-terminal phase is released even though
    // the terminal transition itself is a no-op.
    setup.streamStatus.markUnavailable(setup.streamId, 'transient read error');
    await runRepair(setup, {
      closeRunningGroups: closeAllGroups,
      finalizeExecution: createDurableFinalizer(),
      classifyRun: classifyAs({
        kind: 'finished',
        outcome: RUN_OUTCOME.CANCELLED,
      }),
    });

    expect(setup.streamStatus.holdState(setup.streamId)).toBeUndefined();
    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.CANCELLED);
  });

  it('acts on the durable facts re-read under the settlement lease, not the pre-claim classification', async () => {
    const setup = setupStream('finished-under-lease');
    const closeRunningGroups = vi.fn(closeAllGroups);
    const finalizeExecution = createDurableFinalizer();
    // Resumable before the claim; another process finished it before the
    // lock was taken. The fresh read wins: nothing is written over COMPLETED.
    // Ownership is the lock itself, so it is not asked again under it.
    const classifyRun = classifyAs({ kind: 'resumable' });
    const deriveResumability = vi.fn(async () =>
      factsFor({ kind: 'finished', outcome: RUN_OUTCOME.COMPLETED }),
    );

    await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution,
      classifyRun,
      deriveResumability,
    });

    expect(classifyRun).toHaveBeenCalledOnce();
    expect(deriveResumability).toHaveBeenCalledExactlyOnceWith(
      setup.executionId,
    );
    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.COMPLETED);
    expect(closeRunningGroups).toHaveBeenCalledExactlyOnceWith(
      [setup.streamId],
      RUN_OUTCOME.COMPLETED,
      expect.any(Number),
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('settles a finished execution on its persisted outcome without recording', async () => {
    const setup = setupStream('completed');
    const closeRunningGroups = vi.fn(async () => [] as StreamTabId[]);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution,
      classifyRun: classifyAs({
        kind: 'finished',
        outcome: RUN_OUTCOME.COMPLETED,
      }),
    });

    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.COMPLETED);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [setup.streamId],
      RUN_OUTCOME.COMPLETED,
      expect.any(Number),
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('leaves an unclassifiable stream visibly unclassified and classifies the rest', async () => {
    const unreadable = setupStream('unclassifiable');
    const readable = 'stream-readable' as StreamTabId;
    const readableExecution = 'execution-readable' as ExecutionId;
    const closeRunningGroups = vi.fn(closeAllGroups);
    const finalizeExecution = createDurableFinalizer();

    await repairRestartedStreams({
      streamStatus: unreadable.streamStatus,
      repairStreams: [unreadable.streamId, readable],
      executionIds: new Map([
        [unreadable.streamId, unreadable.executionId],
        [readable, readableExecution],
      ]),
      closeRunningGroups,
      finalizeExecution,
      classifyRun: vi.fn(async (executionId: ExecutionId) => {
        if (executionId === unreadable.executionId) {
          throw new Error('metadata temporarily unreadable');
        }
        return { kind: 'finished' as const, outcome: RUN_OUTCOME.COMPLETED };
      }),
      deriveResumability: async () =>
        factsFor({ kind: 'finished', outcome: RUN_OUTCOME.COMPLETED }),
    });

    // Nothing known, nothing mutated, but shown: the cause is the display fact.
    expect(unreadable.streamStatus.get(unreadable.streamId)).toBeUndefined();
    expect(unreadable.streamStatus.holdState(unreadable.streamId)).toBe(
      streamUnreadableMessage('metadata temporarily unreadable'),
    );
    expect(finalizeExecution).not.toHaveBeenCalled();
    expect(unreadable.streamStatus.get(readable)).toBe(STREAM_PHASE.COMPLETED);
    expect(closeRunningGroups).toHaveBeenCalledExactlyOnceWith(
      [readable],
      RUN_OUTCOME.COMPLETED,
      expect.any(Number),
    );
  });

  it('never labels a lease this process holds as another window', async () => {
    const setup = setupStream('owned-here');
    const closeRunningGroups = vi.fn(closeAllGroups);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runRepair(setup, {
      closeRunningGroups,
      classifyRun: classifyAs({ kind: 'owned_here' }),
      logger,
    });

    expect(setup.streamStatus.get(setup.streamId)).toBeUndefined();
    expect(setup.streamStatus.holdState(setup.streamId)).toBe(
      streamUnreadableMessage('lease owned by this process with no live run'),
    );
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('records a resumable stream as CANCELLED, never WAITING, and preserves its checkpoint', async () => {
    const setup = setupStream('resumable');
    const { streamId, executionId, streamStatus } = setup;
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution,
      classifyRun: classifyAs({ kind: 'resumable' }),
      now: 123,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      123,
    );
    expect(finalizeExecution).toHaveBeenCalledWith({
      executionId,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });
  });

  it('keeps a resumable failed run on its FAILED outcome for retry', async () => {
    const setup = setupStream('resumable-failed');
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      closeRunningGroups: closeAllGroups,
      finalizeExecution,
      classifyRun: classifyAs({
        kind: 'resumable',
        outcome: RUN_OUTCOME.FAILED,
      }),
    });

    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.FAILED);
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('closes an unmapped stream as interrupted without recording anything', async () => {
    const setup = setupStream('without-execution');
    const { streamId, streamStatus } = setup;
    const closeRunningGroups = closeGroupsOn(RUN_OUTCOME.CANCELLED);
    const finalizeExecution = createDurableFinalizer();
    const classifyRun = classifyAs({ kind: 'resumable' });

    await runRepair(setup, {
      executionIds: new Map(),
      closeRunningGroups,
      finalizeExecution,
      classifyRun,
      now: 345,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(closeRunningGroups).toHaveBeenCalledWith(
      [streamId],
      RUN_OUTCOME.CANCELLED,
      345,
    );
    expect(classifyRun).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('does not write terminal meta before interrupted groups close', async () => {
    const setup = setupStream('interrupted-close-error');
    const finalizeExecution = createDurableFinalizer();

    await expect(
      runRepair(setup, {
        closeRunningGroups: failGroupClose,
        finalizeExecution,
        classifyRun: classifyAs({ kind: 'finished' }),
      }),
    ).rejects.toThrow('group close failed');

    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('finishes one stream atomically when teardown begins during repair', async () => {
    const firstStream = 'stream-abort-first' as StreamTabId;
    const secondStream = 'stream-abort-second' as StreamTabId;
    const firstExecution = 'execution-abort-first' as ExecutionId;
    const secondExecution = 'execution-abort-second' as ExecutionId;
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    const abort = new AbortController();
    const closeRunningGroups = vi.fn(async (streamIds: StreamTabId[]) => {
      abort.abort();
      return streamIds;
    });
    const finalizeExecution = createDurableFinalizer();

    await repairRestartedStreams({
      streamStatus,
      executionIds: new Map([
        [firstStream, firstExecution],
        [secondStream, secondExecution],
      ]),
      repairStreams: [firstStream, secondStream],
      closeRunningGroups,
      finalizeExecution,
      classifyRun: classifyAs({ kind: 'finished' }),
      signal: abort.signal,
    });

    expect(streamStatus.get(firstStream)).toBe(STREAM_PHASE.CANCELLED);
    expect(finalizeExecution).toHaveBeenCalledWith({
      executionId: firstExecution,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });
    expect(streamStatus.get(secondStream)).toBeUndefined();
    expect(finalizeExecution).toHaveBeenCalledOnce();
  });

  it('skips a candidate that was reused during classification', async () => {
    const setup = setupStream('reused');
    const closeRunningGroups = vi.fn(closeAllGroups);
    let classified = false;

    await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution: createDurableFinalizer(),
      classifyRun: vi.fn(async () => {
        classified = true;
        return { kind: 'finished' as const };
      }),
      isRepairCandidateCurrent: () => !classified,
    });

    expect(setup.streamStatus.get(setup.streamId)).toBeUndefined();
    expect(closeRunningGroups).not.toHaveBeenCalled();
  });

  it('leaves historical failed streams untouched', async () => {
    const setup = setupStream('historical-failed');
    const { streamId, streamStatus } = setup;
    streamStatus.transition(
      streamId,
      STREAM_PHASE.RUNNING,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    streamStatus.transition(
      streamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    const closeRunningGroups = vi.fn(closeAllGroups);
    const finalizeExecution = createDurableFinalizer();

    await runRepair(setup, {
      closeRunningGroups,
      finalizeExecution,
      classifyRun: classifyAs({ kind: 'finished' }),
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(closeRunningGroups).not.toHaveBeenCalled();
    expect(finalizeExecution).not.toHaveBeenCalled();
  });

  it('does not report terminal status when metadata persistence fails', async () => {
    const setup = setupStream('metadata-failure');
    const { streamId, executionId, streamStatus } = setup;
    const durabilityError = new Error('metadata disk write failed');
    const finalizeExecution = vi.fn(async () => ({
      status: 'failed' as const,
      stage: 'terminal-status' as const,
      outcomePersisted: false as const,
      error: durabilityError,
    }));
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runRepair(setup, {
      closeRunningGroups: closeAllGroups,
      finalizeExecution,
      classifyRun: classifyAs({ kind: 'finished' }),
      logger,
    });

    expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
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

  it('records a crashed run as CANCELLED without touching its flow record', async () => {
    const setup = setupStream('real-meta');
    const { executionId } = setup;
    const store = getExecutionStore(executionId);
    await store.writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      description: 'keep this field',
    });
    const flowRecord = {
      shared: { messages: [] },
      cursor: { nextNodeId: 'start' },
    };
    await store.write(flowKey(executionId), flowRecord);
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

    expect(setup.streamStatus.get(setup.streamId)).toBe(STREAM_PHASE.CANCELLED);
    const repairedMeta = await store.readMeta();
    expect(repairedMeta).toMatchObject({
      description: 'keep this field',
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await expect(store.readResultMeta()).resolves.toMatchObject({
      result: {
        outcome: RUN_OUTCOME.CANCELLED,
        response: 'interim response',
      },
    });
    await expect(store.read(flowKey(executionId))).resolves.toEqual(flowRecord);
  });
});
