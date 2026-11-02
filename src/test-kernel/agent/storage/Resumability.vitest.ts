import { it } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import {
  AgentConfigSchema,
  emptyRunEndOutput,
  qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
} from '@texra-ai/harness/schemas';
import { deriveResumability } from '@agent/storage/resumability';
import { positionRow } from '@agent/runtime/loop/rows';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog, RunHistory } from '@shared/session/runHistory';
import {
  createProcessSession,
  publishTestRunStart,
  seedRows,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: Context.Context<SessionServices>;
  beforeEach(async () => {
    session = await Effect.runPromise(createProcessSession());
  });

  const start = (runId: RunId) =>
    Effect.sync(() => publishTestRunStart(session, runId)).pipe(
      Effect.andThen(Context.get(session, SessionLog).settled),
    );

  /** Open the run aggregate the way the loop does: claim, then the
   *  position that opens it. */
  const open = (runId: RunId) =>
    Effect.gen(function* () {
      const cell = yield* Context.get(session, RunHistory).open(runId, {
        activation: () => Effect.succeed([]),
      });
      yield* cell.append([positionRow(runId, { turn: 0 }, 'turn.ready')]);
    });

  const fail = (runId: RunId) =>
    Context.get(session, SessionLog).transact([
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

      expect(
        yield* deriveResumability(runId).pipe(Effect.provide(session)),
      ).toMatchObject({
        kind: 'checkpoint',
      });
    }),
  );

  it.effect('does not resume a document task that ended: it runs again', () =>
    Effect.gen(function* () {
      const runId = 'ac0001' as RunId;
      yield* start(runId);
      yield* seedRows(Context.get(session, SessionLog))([
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

      expect(
        yield* deriveResumability(runId).pipe(Effect.provide(session)),
      ).toEqual({
        kind: 'finished',
      });
    }),
  );
});
