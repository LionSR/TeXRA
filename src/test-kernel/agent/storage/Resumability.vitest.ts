import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import { deriveResumability } from '@agent/storage/resumability';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { positionRow } from '@agent/runtime/loop/rows';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
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
    session = await Effect.runPromise(createProcessSession());
  });

  const start = (runId: RunId) =>
    Effect.sync(() => publishTestRunStart(session, runId)).pipe(
      Effect.andThen(session.log.settled),
    );

  /** Open the run aggregate the way the loop does: claim, then the
   *  position that opens it. */
  const open = (runId: RunId) =>
    Effect.gen(function* () {
      const cell = yield* session.runHistory.open(runId, {
        activation: () => Effect.succeed([]),
      });
      yield* cell.append([positionRow(runId, { turn: 0 }, 'turn.ready')]);
    });

  const fail = (runId: RunId) =>
    session.log.transact([
      {
        type: 'run.end',
        aggregateId: qualifyAggregateId('run', runId),
        outcome: RUN_OUTCOME.FAILED,
        output: emptyRunEndOutput(),
      },
    ]);

  it.effect('keeps a failed run resumable while its rows stand', () =>
    Effect.gen(function* () {
      const runId = 'ac0000' as RunId;
      yield* start(runId);
      yield* fail(runId);
      yield* open(runId);

      expect(yield* deriveResumability(runId, session)).toMatchObject({
        kind: 'checkpoint',
      });
    }),
  );

  it.effect('does not resume a document task that ended: it runs again', () =>
    Effect.gen(function* () {
      const runId = 'ac0001' as RunId;
      yield* start(runId);
      yield* seedRows(session.log)([
        {
          type: 'run.config',
          aggregateId: qualifyAggregateId('run', runId),
          config: Schema.decodeUnknownSync(AgentConfigSchema)(
            asDocumentTask({ agent: 'polish', model: 'test-model' }),
          ),
        },
      ]);
      yield* open(runId);
      yield* fail(runId);

      expect(yield* deriveResumability(runId, session)).toEqual({
        kind: 'none',
      });
    }),
  );
});
