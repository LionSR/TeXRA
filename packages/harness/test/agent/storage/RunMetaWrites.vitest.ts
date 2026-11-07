import { layer } from '@effect/vitest';
import { Effect, Context, Schema } from 'effect';
import { expect } from 'vitest';
import { RunIdSchema, qualifyAggregateId } from '@texra-ai/harness/schemas';
import { endRunRows } from '@agent/storage/runLifecycle';
import { Inbox } from '@agent/followUp/Inbox';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

const id = Schema.decodeUnknownSync(RunIdSchema)('bbb001');

/** The test's session, with the run `id` started on it. */
const startedSession = Effect.gen(function* () {
  const session = yield* isolatedTestSession();
  yield* publishTestRunStart(session, id);
  yield* Context.get(session, SessionLog).settled;
  return session;
});

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'run metadata updates',
  (it) => {
    it.layer(FakeHost.layer({ workspacePath: '/workspace' }), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'preserves description and outcome when independent facts overlap',
        () =>
          Effect.gen(function* () {
            const session = yield* startedSession;
            yield* Effect.all(
              [
                Context.get(session, SessionLog).transact([
                  {
                    type: 'run.description',
                    by: 'model',
                    aggregateId: qualifyAggregateId('run', id),
                    description: 'A described session',
                  },
                ]),
                endRunRows({
                  runId: id,
                  outcome: 'completed',
                }).pipe(Effect.provide(session)),
              ],
              { concurrency: 'unbounded' },
            );
            expect(
              (yield* Context.get(session, SessionViewAccess).read([
                id,
              ])).runs.get(id),
            ).toMatchObject({
              description: 'A described session',
              outcome: 'completed',
            });
          }),
      );
      // A model switch that cannot apply fails the run: its end consumes the
      // request, so no resume meets it again.
      it.effect('settles a request the run never applied with its end', () =>
        Effect.gen(function* () {
          const session = yield* startedSession;
          yield* Context.get(session, Inbox).send(id, {
            text: '/model gone',
            from: { kind: 'user' },
            control: { kind: 'model', model: 'gone' },
          });
          expect(
            (yield* Context.get(session, Inbox).read(id)).followUps,
          ).toHaveLength(1);
          yield* endRunRows({ runId: id, outcome: 'failed' }).pipe(
            Effect.provide(session),
          );
          expect(
            (yield* Context.get(session, Inbox).read(id)).followUps,
          ).toEqual([]);
        }),
      );
    });
  },
);
