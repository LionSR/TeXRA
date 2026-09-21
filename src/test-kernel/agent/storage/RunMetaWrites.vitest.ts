import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import { finalizeRun, getRunRecords } from '@agent/storage';
import { aggregateId, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
let session: ReturnType<typeof createTestSession>;
const id = 'bbb001' as RunId;
beforeEach(async () => {
  session = createTestSession();
  publishTestRunStart(session, id);
  await Effect.runPromise(session.settlePublications());
});

describe('run metadata updates', () => {
  it.effect(
    'preserves description and outcome when independent facts overlap',
    () =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            session.commit([
              {
                type: 'run.description',
                aggregateId: aggregateId('run', id),
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
        expect((yield* session.readView([id])).runs.get(id)).toMatchObject({
          description: 'A described session',
          status: 'completed',
        });
      }),
  );
  it.effect('keeps a driver outcome when host-exit finalization follows', () =>
    Effect.gen(function* () {
      yield* finalizeRun(session, {
        runId: id,
        outcome: 'completed',
      });
      yield* finalizeRun(session, {
        runId: id,
        outcome: 'cancelled',
        keepExistingOutcome: true,
      });
      expect(yield* getRunRecords(session, id).readRunEnd()).toMatchObject({
        outcome: 'completed',
      });
    }),
  );
});
