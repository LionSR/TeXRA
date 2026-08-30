import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  deriveResumability,
  finalizeRun,
  getExecutionStore,
} from '@agent/storage';
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
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

const BASE_FLOW_RECORD: FlowRecord = {
  shared: { messages: [] },
  cursor: { nextNodeId: 'start' },
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

  it('keeps a failed execution resumable while its checkpoint exists', async () => {
    const executionId = 'failed-with-flow' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.FAILED });
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('stays resumable when terminal metadata persists but flow deletion fails', async () => {
    const executionId = 'failed-finalization-with-flow' as ExecutionId;
    await writeMeta(executionId, {});
    await writeFlow(executionId);
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'delete').mockRejectedValueOnce(
      new Error('flow delete failed'),
    );

    await expect(
      finalizeRun({
        executionId,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'delete',
      }),
    ).resolves.toMatchObject({
      ok: false,
      outcomePersisted: true,
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.COMPLETED,
    });
  });

  it('does not treat a spent cursor as a checkpoint', async () => {
    const executionId = 'completed-spent-cursor' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.COMPLETED });
    await getExecutionStore(executionId).write(flowKey(executionId), {
      ...BASE_FLOW_RECORD,
      cursor: { ...BASE_FLOW_RECORD.cursor, nextNodeId: null },
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      kind: 'unreadable',
      cause: 'checkpoint is malformed',
    });
  });

  it('keeps a preserved checkpoint when terminal metadata fails for a failed execution', async () => {
    const executionId = 'failed-terminal-metadata-with-flow' as ExecutionId;
    await writeMeta(executionId, {});
    await writeFlow(executionId);
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'writeMeta').mockRejectedValueOnce(
      new Error('metadata disk full'),
    );

    await expect(
      finalizeRun({
        executionId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'preserve',
      }),
    ).resolves.toMatchObject({
      ok: false,
      outcomePersisted: false,
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      kind: 'checkpoint',
    });
  });

  it('marks cancelled executions with a valid flow record as resumable', async () => {
    const executionId = 'cancelled-with-flow' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('does not mark cancelled executions resumable without a flow record', async () => {
    const executionId = 'cancelled-missing-flow' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      kind: 'none',
      outcome: RUN_OUTCOME.CANCELLED,
    });
  });

  it('marks missing-terminal executions with a valid flow record as resumable', async () => {
    const executionId = 'crash-with-flow' as ExecutionId;
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      kind: 'checkpoint',
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

    expect(decision).toMatchObject({ kind: 'checkpoint' });
    if (decision.kind !== 'checkpoint') return;
    expect(decision.flowRecord).toEqual(legacyRecord);
    expect(Object.hasOwn(decision.flowRecord, 'schemaVersion')).toBe(false);
  });

  it('reports missing flow records as not resumable', async () => {
    const executionId = 'missing-flow' as ExecutionId;

    await expect(deriveResumability(executionId)).resolves.toEqual({
      kind: 'none',
      outcome: undefined,
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
      kind: 'unreadable',
      cause: 'checkpoint is malformed',
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
      kind: 'unreadable',
      cause: 'execution metadata is malformed',
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
      kind: 'unreadable',
      cause: 'checkpoint could not be read (disk offline)',
    });
  });
});
