import { Effect } from 'effect';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  deriveResumability,
  finalizeRun,
  getExecutionStore,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  aggregateId,
  type StreamTabId,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

const BASE_FLOW_RECORD: FlowRecord = {
  shared: { messages: [] },
  cursor: { nextNodeId: 'start' },
};

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(() => {
    clearStoreCache();
    vi.restoreAllMocks();
    session = createProcessSession();
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
    const streamId = `stream-${executionId}` as StreamTabId;
    publishTestRunStart(session, streamId, executionId);
    await session.settlePublications();
    if (outcome) {
      await Effect.runPromise(
        session.commit([
          {
            type: 'status',
            aggregateId: aggregateId('stream', streamId),
            phase: outcome,
            cause: 'test outcome',
          },
        ]),
      );
    }
  }

  it('keeps a failed execution resumable while its checkpoint exists', async () => {
    const executionId = 'ac0000' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.FAILED });
    await writeFlow(executionId);

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('stays resumable when terminal metadata persists but flow deletion fails', async () => {
    const executionId = 'ac0001' as ExecutionId;
    await writeMeta(executionId, {});
    await writeFlow(executionId);
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'delete').mockRejectedValueOnce(
      new Error('flow delete failed'),
    );

    await expect(
      Effect.runPromise(
        finalizeRun(session, {
          executionId,
          outcome: RUN_OUTCOME.COMPLETED,
          flowRecord: 'delete',
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      outcomePersisted: true,
    });

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.COMPLETED,
    });
  });

  it('does not treat a spent cursor as a checkpoint', async () => {
    const executionId = 'ac0002' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.COMPLETED });
    await getExecutionStore(executionId).write(flowKey(executionId), {
      ...BASE_FLOW_RECORD,
      cursor: { ...BASE_FLOW_RECORD.cursor, nextNodeId: null },
    });

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      cause: 'checkpoint is malformed',
    });
  });

  it('keeps a preserved checkpoint when terminal metadata fails for a failed execution', async () => {
    const executionId = 'ac0003' as ExecutionId;
    await writeMeta(executionId, {});
    await writeFlow(executionId);
    vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
      Effect.die(new Error('metadata disk full')),
    );

    await expect(
      Effect.runPromise(
        finalizeRun(session, {
          executionId,
          outcome: RUN_OUTCOME.FAILED,
          flowRecord: 'preserve',
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      outcomePersisted: false,
    });

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
    });
  });

  it('marks cancelled executions with a valid flow record as resumable', async () => {
    const executionId = 'ac0004' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });
    await writeFlow(executionId);

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('does not mark cancelled executions resumable without a flow record', async () => {
    const executionId = 'ac0005' as ExecutionId;
    await writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'none',
      outcome: RUN_OUTCOME.CANCELLED,
    });
  });

  it('marks missing-terminal executions with a valid flow record as resumable', async () => {
    const executionId = 'ac0006' as ExecutionId;
    await writeFlow(executionId);

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('accepts an unstamped legacy envelope and preserves extra fields', async () => {
    const executionId = 'ac0007' as ExecutionId;
    const legacyRecord = {
      ...BASE_FLOW_RECORD,
      legacyOwner: { host: 'extension' },
    };
    await getExecutionStore(executionId).write(
      flowKey(executionId),
      legacyRecord,
    );

    const decision = await Effect.runPromise(
      deriveResumability(executionId, session),
    );

    expect(decision).toMatchObject({ kind: 'checkpoint' });
    if (decision.kind !== 'checkpoint') return;
    expect(decision.flowRecord).toEqual(legacyRecord);
    expect(Object.hasOwn(decision.flowRecord, 'schemaVersion')).toBe(false);
  });

  it('reports missing flow records as not resumable', async () => {
    const executionId = 'ac0008' as ExecutionId;

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toEqual({
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
    const executionId = 'ac0009' as ExecutionId;
    await getExecutionStore(executionId).write(flowKey(executionId), record);

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toEqual({
      kind: 'unreadable',
      // The one fault that names the record itself: callers refuse this
      // cohort as unusable saved state, and every other fault operationally.
      fault: 'checkpoint-malformed',
      cause: 'checkpoint is malformed',
    });
  });

  it('reports invalid metadata as not resumable even with a valid flow record', async () => {
    const executionId = 'ac000a' as ExecutionId;
    vi.spyOn(session, 'readExecutionRecords').mockReturnValue(
      Effect.die(
        new z.ZodError([
          { code: 'custom', path: [], message: 'corrupt execution metadata' },
        ]),
      ),
    );
    await writeFlow(executionId);

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      cause: 'execution metadata is malformed',
    });
  });

  it('reports unreadable flow records as not resumable', async () => {
    const executionId = 'ac000b' as ExecutionId;
    const store = getExecutionStore(executionId);
    await writeFlow(executionId);
    const originalRead = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (key) => {
      if (key === flowKey(executionId)) {
        throw new Error('disk offline');
      }
      return originalRead(key);
    });

    await expect(
      Effect.runPromise(deriveResumability(executionId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      cause: 'checkpoint could not be read (disk offline)',
    });
  });
});
