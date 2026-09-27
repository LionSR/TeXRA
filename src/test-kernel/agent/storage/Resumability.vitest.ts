import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { deriveResumability, finalizeRun } from '@agent/storage';
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
    modelId: 'test-model',
    modelCompatibilityKey: null,
    lastError: null,
    declinedRoutes: [],
  },
  state: { stateSlices: null, offeredTools: [], toolsetHash: '0'.repeat(64) },
};

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(async () => {
    vi.restoreAllMocks();
    session = await Effect.runPromise(createProcessSession());
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

  async function writeMeta(
    runId: RunId,
    { outcome }: { outcome?: RunOutcome },
  ): Promise<void> {
    publishTestRunStart(session, runId);
    await Effect.runPromise(session.settlePublications());
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

  it.effect('keeps a failed run resumable while its snapshot stands', () =>
    Effect.gen(function* () {
      const runId = 'ac0000' as RunId;
      yield* Effect.promise(() =>
        writeMeta(runId, { outcome: RUN_OUTCOME.FAILED }),
      );
      yield* Effect.promise(() => writeSnapshot(runId));

      expect(yield* deriveResumability(runId, session)).toMatchObject({
        kind: 'checkpoint',
        snapshot: OPENING_SNAPSHOT,
      });
    }),
  );

  it.effect(
    'keeps the snapshot when terminal metadata fails for a failed run',
    () =>
      Effect.gen(function* () {
        const runId = 'ac0003' as RunId;
        yield* Effect.promise(() => writeMeta(runId, {}));
        yield* Effect.promise(() => writeSnapshot(runId));
        vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
          Effect.die(new Error('metadata disk full')),
        );

        expect(
          yield* finalizeRun(session, { runId, outcome: RUN_OUTCOME.FAILED }),
        ).toMatchObject({
          ok: false,
          outcomePersisted: false,
        });

        expect(yield* deriveResumability(runId, session)).toMatchObject({
          kind: 'checkpoint',
        });
      }),
  );

  it.effect('does not mark a cancelled run resumable without a snapshot', () =>
    Effect.gen(function* () {
      const runId = 'ac0005' as RunId;
      yield* Effect.promise(() =>
        writeMeta(runId, { outcome: RUN_OUTCOME.CANCELLED }),
      );

      expect(yield* deriveResumability(runId, session)).toEqual({
        kind: 'none',
      });
    }),
  );

  it.effect(
    'reports unreadable metadata as unreadable even with a snapshot',
    () =>
      Effect.gen(function* () {
        const runId = 'ac000a' as RunId;
        yield* Effect.promise(() => writeMeta(runId, {}));
        yield* Effect.promise(() => writeSnapshot(runId));
        vi.spyOn(session, 'readRunRecords').mockReturnValue(
          Effect.fail(
            new DatabaseReadFailed({
              path: 'session.db',
              cause: new Error('corrupt run metadata'),
            }),
          ),
        );

        expect(yield* deriveResumability(runId, session)).toEqual({
          kind: 'unreadable',
          cause: 'run metadata could not be read (corrupt run metadata)',
        });
      }),
  );

  it.effect('reports an unreadable snapshot as unreadable', () =>
    Effect.gen(function* () {
      const runId = 'ac000b' as RunId;
      yield* Effect.promise(() => writeMeta(runId, {}));
      vi.spyOn(session.ledger, 'latestSnapshot').mockReturnValue(
        Effect.fail(
          new DatabaseReadFailed({
            path: 'session.db',
            cause: new Error('disk offline'),
          }),
        ),
      );

      expect(yield* deriveResumability(runId, session)).toEqual({
        kind: 'unreadable',
        cause: 'checkpoint could not be read (disk offline)',
      });
    }),
  );
});
