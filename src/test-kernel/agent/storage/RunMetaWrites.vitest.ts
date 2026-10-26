import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
let session: SessionHandle;
const id = 'bbb001' as RunId;
beforeEach(async () => {
  session = await Effect.runPromise(createTestSession());
  publishTestRunStart(session, id);
  await Effect.runPromise(session.log.settled);
});

describe('run metadata updates', () => {
  it.effect(
    'preserves description and outcome when independent facts overlap',
    () =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            session.log.transact([
              {
                type: 'run.description',
                by: 'model',
                aggregateId: qualifyAggregateId('run', id),
                description: 'A described session',
              },
            ]),
            finalizeRun(session, {
              runId: id,
              outcome: 'completed',
            }),
          ],
          { concurrency: 'unbounded' },
        );
        expect((yield* session.view.read([id])).runs.get(id)).toMatchObject({
          description: 'A described session',
          status: 'completed',
        });
      }),
  );
  // A model switch that cannot apply fails the run: its end consumes the
  // request, so no resume meets it again.
  it.effect('settles a request the run never applied with its end', () =>
    Effect.gen(function* () {
      yield* session.followUps.send(id, {
        text: '/model gone',
        from: { kind: 'user' },
        control: { kind: 'model', model: 'gone' },
      });
      expect((yield* session.followUps.read(id)).followUps).toHaveLength(1);
      yield* finalizeRun(session, { runId: id, outcome: 'failed' });
      expect((yield* session.followUps.read(id)).followUps).toEqual([]);
    }),
  );
});
