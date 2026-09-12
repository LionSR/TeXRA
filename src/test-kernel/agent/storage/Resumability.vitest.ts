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
  aggregateId,
  AgentCategory,
  emptyRunEndOutput,
  type FlowSnapshotPayload,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

/** The opening snapshot of a tool-use run, as the loop's first batch writes it. */
const OPENING_SNAPSHOT: FlowSnapshotPayload = {
  family: 'toolUse',
  runtime: {
    phase: 'initial',
    round: 0,
    turn: 0,
    continuationIndex: 0,
    modelId: 'test-model',
    modelHandlerCompatibilityKey: null,
    lastError: null,
    pendingRetry: null,
  },
  references: { pendingIntents: [], pendingResponse: null },
  state: { shouldSkipCycle: false, stateSlices: null },
};

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(() => {
    clearStoreCache();
    vi.restoreAllMocks();
    session = createProcessSession();
  });

  /** Open the run aggregate the way the loop does: claim, then snapshot. */
  async function writeSnapshot(runId: RunId): Promise<void> {
    await Effect.runPromise(session.ledger.acquire(runId));
    await Effect.runPromise(
      session.ledger.appendBatch(runId, null, [
        {
          type: 'flow.snapshot',
          aggregateId: aggregateId('run', runId),
          payload: OPENING_SNAPSHOT,
        },
      ]),
    );
  }

  /** The retired engine's checkpoint, which this release never reads (R10). */
  async function writeLegacyFlowRecord(runId: RunId): Promise<void> {
    await getRunStore(runId).write(`flow_${runId}`, {
      shared: { messages: [] },
      cursor: { nextNodeId: 'start' },
    });
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

  it('keeps a failed run resumable while its snapshot stands', async () => {
    const runId = 'ac0000' as RunId;
    await writeMeta(runId, { outcome: RUN_OUTCOME.FAILED });
    await writeSnapshot(runId);

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      outcome: RUN_OUTCOME.FAILED,
      snapshot: OPENING_SNAPSHOT,
    });
  });

  it('keeps the snapshot when terminal metadata fails for a failed run', async () => {
    const runId = 'ac0003' as RunId;
    await writeMeta(runId, {});
    await writeSnapshot(runId);
    vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
      Effect.die(new Error('metadata disk full')),
    );

    await expect(
      Effect.runPromise(
        finalizeRun(session, { runId, outcome: RUN_OUTCOME.FAILED }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      outcomePersisted: false,
    });

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({ kind: 'checkpoint' });
  });

  it('does not mark a cancelled run resumable without a snapshot', async () => {
    const runId = 'ac0005' as RunId;
    await writeMeta(runId, { outcome: RUN_OUTCOME.CANCELLED });

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toEqual({
      kind: 'none',
      outcome: RUN_OUTCOME.CANCELLED,
    });
  });

  it('reports a run with no durable state as not resumable', async () => {
    const runId = 'ac0008' as RunId;

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toEqual({ kind: 'none' });
  });

  // R10: the retired checkpoint is never read and never silently ignored —
  // the run is not resumable under this release, and says so.
  it('names a run whose only durable state is a retired checkpoint', async () => {
    const runId = 'ac0009' as RunId;
    await writeLegacyFlowRecord(runId);

    const decision = await Effect.runPromise(
      deriveResumability(runId, session),
    );

    expect(decision).toMatchObject({ kind: 'none' });
    expect(decision.kind === 'none' ? decision.notice : undefined).toContain(
      'not resumable under this release',
    );
  });

  it('reports malformed metadata as unreadable even with a snapshot', async () => {
    const runId = 'ac000a' as RunId;
    await writeMeta(runId, {});
    await writeSnapshot(runId);
    vi.spyOn(session, 'readRunRecords').mockReturnValue(
      Effect.die(
        new z.ZodError([
          { code: 'custom', path: [], message: 'corrupt run metadata' },
        ]),
      ),
    );

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      fault: 'metadata-malformed',
      cause: 'run metadata is malformed',
    });
  });

  it('reports an unreadable snapshot as unreadable', async () => {
    const runId = 'ac000b' as RunId;
    await writeMeta(runId, {});
    vi.spyOn(session.ledger, 'latestSnapshot').mockReturnValue(
      Effect.fail(
        new DatabaseReadFailed({
          path: 'session.db',
          cause: new Error('disk offline'),
        }),
      ),
    );

    await expect(
      Effect.runPromise(deriveResumability(runId, session)),
    ).resolves.toMatchObject({
      kind: 'unreadable',
      fault: 'checkpoint-unreadable',
      cause: 'checkpoint could not be read (disk offline)',
    });
  });
});
