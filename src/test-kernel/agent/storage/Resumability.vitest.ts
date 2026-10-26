import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { deriveResumability } from '@agent/storage/resumability';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { positionRow } from '@agent/runtime/loop/rows';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import {
  createProcessSession,
  publishTestRunStart,
  seedRows,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(async () => {
    vi.restoreAllMocks();
    session = await Effect.runPromise(createProcessSession());
  });

  /** Open the run aggregate the way the loop does: claim, then the
   *  position that opens it. */
  async function writeOpening(runId: RunId): Promise<void> {
    const cell = await Effect.runPromise(
      session.runHistory.open(runId, { activation: () => Effect.succeed([]) }),
    );
    await Effect.runPromise(
      cell.append([positionRow(runId, { turn: 0 }, 'turn.ready')]),
    );
  }

  async function writeMeta(
    runId: RunId,
    { outcome }: { outcome?: RunOutcome },
  ): Promise<void> {
    publishTestRunStart(session, runId);
    await Effect.runPromise(session.log.settled);
    if (outcome) {
      await Effect.runPromise(
        session.log.transact([
          {
            type: 'run.end',
            aggregateId: qualifyAggregateId('run', runId),
            outcome,
            output: emptyRunEndOutput(),
          },
        ]),
      );
    }
  }

  it.effect('keeps a failed run resumable while its rows stand', () =>
    Effect.gen(function* () {
      const runId = 'ac0000' as RunId;
      yield* Effect.promise(() =>
        writeMeta(runId, { outcome: RUN_OUTCOME.FAILED }),
      );
      yield* Effect.promise(() => writeOpening(runId));

      expect(yield* deriveResumability(runId, session)).toMatchObject({
        kind: 'checkpoint',
      });
    }),
  );

  it.effect('does not resume a document task that ended: it runs again', () =>
    Effect.gen(function* () {
      const runId = 'ac0001' as RunId;
      yield* Effect.promise(() => writeMeta(runId, {}));
      yield* seedRows(session.log)([
        {
          type: 'run.config',
          aggregateId: qualifyAggregateId('run', runId),
          config: Schema.decodeUnknownSync(AgentConfigSchema)(
            asDocumentTask({ agent: 'polish', model: 'test-model' }),
          ),
        },
      ]);
      yield* Effect.promise(() => writeOpening(runId));
      yield* session.log.transact([
        {
          type: 'run.end',
          aggregateId: qualifyAggregateId('run', runId),
          outcome: RUN_OUTCOME.FAILED,
          output: emptyRunEndOutput(),
        },
      ]);

      expect(yield* deriveResumability(runId, session)).toEqual({
        kind: 'none',
      });
    }),
  );

  it.effect('reports unreadable metadata as unreadable even when opened', () =>
    Effect.gen(function* () {
      const runId = 'ac000a' as RunId;
      yield* Effect.promise(() => writeMeta(runId, {}));
      yield* Effect.promise(() => writeOpening(runId));
      vi.spyOn(session.log, 'records').mockReturnValue(
        Effect.fail(
          new DatabaseReadFailed({
            path: 'session.db',
            cause: new Error('corrupt run metadata'),
          }),
        ),
      );
      vi.spyOn(session.log, 'rows').mockReturnValue(
        Effect.fail(
          new DatabaseReadFailed({
            path: 'session.db',
            cause: new Error('corrupt run metadata'),
          }),
        ),
      );

      expect(yield* deriveResumability(runId, session)).toEqual({
        kind: 'unreadable',
        cause: 'run state could not be read (corrupt run metadata)',
      });
    }),
  );
});
