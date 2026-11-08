import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { expect } from 'vitest';

import {
  RunIdSchema,
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
import { publishTestRunStart, seedRows } from '@test/support/sessionTestUtils';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

type Session = Context.Context<SessionServices>;

/** The test's session over the process roots. */
const processSession = Effect.flatMap(TestSession.open(), sessionHandleOf);

const start = (session: Session, runId: RunId) =>
  publishTestRunStart(session, runId).pipe(
    Effect.andThen(Context.get(session, SessionLog).settled),
  );

/** Open the run aggregate the way the loop does: its activation, then
 *  the position that opens it. */
const open = (session: Session, runId: RunId) =>
  Effect.gen(function* () {
    const cell = yield* Context.get(session, RunHistory).open(runId, {
      activation: () => Effect.succeed([]),
    });
    yield* cell.append([positionRow(runId, { turn: 0 }, 'turn.ready')]);
  });

const fail = (session: Session, runId: RunId) =>
  Context.get(session, SessionLog).transact([
    {
      type: 'run.end',
      aggregateId: qualifyAggregateId('run', runId),
      outcome: RUN_OUTCOME.FAILED,
      output: emptyRunEndOutput(),
    },
  ]);

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'deriveResumability',
  (it) => {
    it.layer(FakeHost.layer({ workspaceRoot: '/workspace' }), {
      buildPerTest: true,
    })((it) => {
      it.effect('keeps a failed run resumable while its rows stand', () =>
        Effect.gen(function* () {
          const session = yield* processSession;
          const runId = Schema.decodeUnknownSync(RunIdSchema)('ac0000');
          yield* start(session, runId);
          yield* fail(session, runId);
          yield* open(session, runId);

          expect(
            yield* deriveResumability(runId).pipe(Effect.provide(session)),
          ).toMatchObject({
            kind: 'checkpoint',
          });
        }),
      );

      it.effect(
        'does not resume a document task that ended: it runs again',
        () =>
          Effect.gen(function* () {
            const session = yield* processSession;
            const runId = Schema.decodeUnknownSync(RunIdSchema)('ac0001');
            yield* start(session, runId);
            yield* seedRows(Context.get(session, SessionLog))([
              {
                type: 'run.config',
                aggregateId: qualifyAggregateId('run', runId),
                config: Schema.decodeUnknownSync(AgentConfigSchema)(
                  asDocumentTask({ agent: 'polish', model: 'test-model' }),
                ),
              },
            ]);
            yield* open(session, runId);
            yield* fail(session, runId);

            expect(
              yield* deriveResumability(runId).pipe(Effect.provide(session)),
            ).toEqual({
              kind: 'finished',
            });
          }),
      );
    });
  },
);
