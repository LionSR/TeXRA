import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  deriveResumability,
  finalizeExecution,
  getExecutionStore,
  RESUMABILITY_CAUSE,
} from '@agent/storage';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  EXECUTION_META_SCHEMA_VERSION,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

const BASE_FLOW_RECORD: FlowRecord = {
  flowName: 'texra',
  params: {},
  shared: { messages: [] },
  createdAt: '2026-07-05T00:00:00.000Z',
  nodes: [],
};

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
    vi.restoreAllMocks();
  });

  async function writeFlow(executionId: ExecutionId): Promise<void> {
    await getExecutionStore(executionId).write(
      flowKey(executionId),
      BASE_FLOW_RECORD,
    );
  }

  async function writeMeta(
    executionId: ExecutionId,
    { outcome }: { outcome?: RunOutcome },
  ): Promise<void> {
    await getExecutionStore(executionId).writeMeta({
      schemaVersion: EXECUTION_META_SCHEMA_VERSION,
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome,
    });
  }

  it.each([
    {
      name: 'does not let a stale flow record make completed executions resumable',
      executionId: 'completed-with-flow' as ExecutionId,
      outcome: RUN_OUTCOME.COMPLETED,
      cause: RESUMABILITY_CAUSE.TERMINAL_COMPLETED,
    },
    {
      name: 'does not let a stale flow record make failed executions resumable',
      executionId: 'failed-with-flow' as ExecutionId,
      outcome: RUN_OUTCOME.FAILED,
      cause: RESUMABILITY_CAUSE.TERMINAL_FAILED,
    },
  ])('$name', async ({ executionId, outcome, cause }) => {
    await writeMeta(executionId, { outcome });
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause,
      outcome,
    });
  });

  it('stays non-resumable when terminal metadata persists but flow deletion fails', async () => {
    const executionId = 'failed-finalization-with-flow' as ExecutionId;
    await writeMeta(executionId, {});
    await writeFlow(executionId);
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'delete').mockRejectedValueOnce(
      new Error('flow delete failed'),
    );

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'delete',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      stage: 'flow-record-delete',
      outcomePersisted: true,
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.TERMINAL_FAILED,
      outcome: RUN_OUTCOME.FAILED,
    });
  });

  it('fails closed when terminal metadata fails for a failed execution', async () => {
    const executionId = 'failed-terminal-metadata-with-flow' as ExecutionId;
    await writeMeta(executionId, {});
    await writeFlow(executionId);
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'writeMeta').mockRejectedValueOnce(
      new Error('metadata disk full'),
    );

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'preserve',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      stage: 'terminal-status',
      outcomePersisted: false,
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.MISSING_FLOW,
    });
  });

  it('marks cancelled executions with a valid flow record as resumable', async () => {
    const executionId = 'cancelled-with-flow' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: true,
      cause: RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('does not mark cancelled executions resumable without a flow record', async () => {
    const executionId = 'cancelled-missing-flow' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.MISSING_FLOW,
      outcome: RUN_OUTCOME.CANCELLED,
    });
  });

  it('marks missing-terminal executions with a valid flow record as resumable', async () => {
    const executionId = 'crash-with-flow' as ExecutionId;
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: true,
      cause: RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('accepts an unstamped legacy envelope and preserves extra fields', async () => {
    const executionId = 'legacy-extra-flow-envelope' as ExecutionId;
    const legacyRecord = {
      ...BASE_FLOW_RECORD,
      legacyOwner: { host: 'extension' },
    };
    await getExecutionStore(executionId).write(
      flowKey(executionId),
      legacyRecord,
    );

    const decision = await deriveResumability(executionId);

    expect(decision).toMatchObject({
      resumable: true,
      cause: RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
    });
    if (!decision.resumable) return;
    expect(decision.flowRecord).toEqual(legacyRecord);
    expect(Object.hasOwn(decision.flowRecord, 'schemaVersion')).toBe(false);
  });

  it('reports missing flow records as not resumable', async () => {
    const executionId = 'missing-flow' as ExecutionId;

    await expect(deriveResumability(executionId)).resolves.toEqual({
      resumable: false,
      cause: RESUMABILITY_CAUSE.MISSING_FLOW,
    });
  });

  it.each([
    {
      name: 'reports invalid flow records as not resumable',
      record: { ...BASE_FLOW_RECORD, shared: null },
    },
    {
      name: 'does not conflate a stored null flow envelope with an absent key',
      record: null,
    },
    {
      name: 'rejects flow records from a future envelope schema version',
      record: {
        ...BASE_FLOW_RECORD,
        schemaVersion: FLOW_RECORD_SCHEMA_VERSION + 1,
      },
    },
  ])('$name', async ({ record }) => {
    const executionId = 'invalid-flow' as ExecutionId;
    await getExecutionStore(executionId).write(flowKey(executionId), record);

    await expect(deriveResumability(executionId)).resolves.toEqual({
      resumable: false,
      cause: RESUMABILITY_CAUSE.INVALID_FLOW,
    });
  });

  it('reports invalid metadata as not resumable even with a valid flow record', async () => {
    const executionId = 'invalid-meta-with-flow' as ExecutionId;
    const store = getExecutionStore(executionId);
    await store.write('meta', {
      schemaVersion: 999,
      timestamp: '2026-07-05T00:00:00.000Z',
    });
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.INVALID_META,
    });
  });

  it('reports unreadable flow records as not resumable', async () => {
    const executionId = 'unreadable-flow' as ExecutionId;
    const store = getExecutionStore(executionId);
    await writeFlow(executionId);
    const originalRead = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (key) => {
      if (key === flowKey(executionId)) {
        throw new Error('disk offline');
      }
      return originalRead(key);
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.UNREADABLE_FLOW,
    });
  });

  it('projects only resumable executions into WAITING streams', async () => {
    const crashExecutionId = 'waiting-crash-with-flow' as ExecutionId;
    const cancelledExecutionId = 'waiting-cancelled-with-flow' as ExecutionId;
    const completedExecutionId = 'waiting-completed-with-flow' as ExecutionId;
    const missingFlowExecutionId =
      'waiting-interrupted-missing-flow' as ExecutionId;

    await writeFlow(crashExecutionId);
    await writeMeta(cancelledExecutionId, { outcome: RUN_OUTCOME.CANCELLED });
    await writeFlow(cancelledExecutionId);
    await writeMeta(completedExecutionId, {
      outcome: RUN_OUTCOME.COMPLETED,
    });
    await writeFlow(completedExecutionId);
    await writeMeta(missingFlowExecutionId, {
      outcome: RUN_OUTCOME.CANCELLED,
    });

    const streamIdsByExecutionId = new Map<StreamTabId, ExecutionId>([
      ['crash-stream' as StreamTabId, crashExecutionId],
      ['cancelled-stream' as StreamTabId, cancelledExecutionId],
      ['completed-stream' as StreamTabId, completedExecutionId],
      ['missing-flow-stream' as StreamTabId, missingFlowExecutionId],
    ]);

    await expect(detectWaitingStreams(streamIdsByExecutionId)).resolves.toEqual(
      new Set<StreamTabId>([
        'crash-stream' as StreamTabId,
        'cancelled-stream' as StreamTabId,
      ]),
    );
  });
});
