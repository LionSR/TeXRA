import { Effect } from 'effect';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  deriveResumability,
  finalizeRun,
  getRunStore,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  aggregateId,
  AgentCategory,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
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

  async function writeFlow(runId: RunId): Promise<void> {
    await getRunStore(runId).write(flowKey(runId), BASE_FLOW_RECORD);
  }

  async function writeMeta(
    runId: RunId,
    { outcome }: { outcome?: RunOutcome },
  ): Promise<void> {
    publishTestRunStart(session, runId);
    await session.settlePublications();
    if (outcome) {
      await Effect.runPromise(
        session.commit([
          {
            type: 'run.end',
            aggregateId: aggregateId('run', runId),
            outcome,
            output: emptyRunEndOutput(AgentCategory.ToolUse),
          },
        ]),
      );
    }
  }

  it('keeps a failed run resumable while its checkpoint exists', async () => {
    const runId = 'ac0000' as RunId;
    await writeMeta(runId, { outcome: RUN_OUTCOME.FAILED });
    await writeFlow(runId);

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('stays resumable when terminal metadata persists but flow deletion fails', async () => {
    const runId = 'ac0001' as RunId;
    await writeMeta(runId, {});
    await writeFlow(runId);
    const store = getRunStore(runId);
    vi.spyOn(store, 'delete').mockRejectedValueOnce(
      new Error('flow delete failed'),
    );

    await expect(
      Effect.runPromise(
        finalizeRun(session, {
          runId,
          outcome: RUN_OUTCOME.COMPLETED,
          flowRecord: 'delete',
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      outcomePersisted: true,
    });

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.COMPLETED,
    });
  });

  it('does not treat a spent cursor as a checkpoint', async () => {
    const runId = 'ac0002' as RunId;
    await writeMeta(runId, { outcome: RUN_OUTCOME.COMPLETED });
    await getRunStore(runId).write(flowKey(runId), {
      ...BASE_FLOW_RECORD,
      cursor: { ...BASE_FLOW_RECORD.cursor, nextNodeId: null },
    });

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      cause: 'checkpoint is malformed',
    });
  });

  it('keeps a preserved checkpoint when terminal metadata fails for a failed run', async () => {
    const runId = 'ac0003' as RunId;
    await writeMeta(runId, {});
    await writeFlow(runId);
    vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
      Effect.die(new Error('metadata disk full')),
    );

    await expect(
      Effect.runPromise(
        finalizeRun(session, {
          runId,
          outcome: RUN_OUTCOME.FAILED,
          flowRecord: 'preserve',
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      outcomePersisted: false,
    });

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
    });
  });

  it('does not mark a cancelled run resumable without a flow record', async () => {
    const runId = 'ac0005' as RunId;
    await writeMeta(runId, { outcome: RUN_OUTCOME.CANCELLED });

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'none',
      outcome: RUN_OUTCOME.CANCELLED,
    });
  });

  it('marks missing-terminal runs with a valid flow record as resumable', async () => {
    const runId = 'ac0006' as RunId;
    await writeFlow(runId);

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('accepts an unstamped legacy envelope and preserves extra fields', async () => {
    const runId = 'ac0007' as RunId;
    const legacyRecord = {
      ...BASE_FLOW_RECORD,
      legacyOwner: { host: 'extension' },
    };
    await getRunStore(runId).write(flowKey(runId), legacyRecord);

    const decision = await Effect.runPromise(
      deriveResumability(runId, session),
    );

    expect(decision).toMatchObject({ kind: 'checkpoint' });
    if (decision.kind !== 'checkpoint') return;
    expect(decision.flowRecord).toEqual(legacyRecord);
    expect(Object.hasOwn(decision.flowRecord, 'schemaVersion')).toBe(false);
  });

  it('reports missing flow records as not resumable', async () => {
    const runId = 'ac0008' as RunId;

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
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
    const runId = 'ac0009' as RunId;
    await getRunStore(runId).write(flowKey(runId), record);

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toEqual({
      kind: 'unreadable',
      // The one fault that names the record itself: callers refuse this
      // cohort as unusable saved state, and every other fault operationally.
      fault: 'checkpoint-malformed',
      cause: 'checkpoint is malformed',
    });
  });

  it('reports invalid metadata as not resumable even with a valid flow record', async () => {
    const runId = 'ac000a' as RunId;
    vi.spyOn(session, 'readRunRecords').mockReturnValue(
      Effect.die(
        new z.ZodError([
          { code: 'custom', path: [], message: 'corrupt run metadata' },
        ]),
      ),
    );
    await writeFlow(runId);

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      cause: 'run metadata is malformed',
    });
  });

  it('reports unreadable flow records as not resumable', async () => {
    const runId = 'ac000b' as RunId;
    const store = getRunStore(runId);
    await writeFlow(runId);
    const originalRead = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (key) => {
      if (key === flowKey(runId)) {
        throw new Error('disk offline');
      }
      return originalRead(key);
    });

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      cause: 'checkpoint could not be read (disk offline)',
    });
  });
});
