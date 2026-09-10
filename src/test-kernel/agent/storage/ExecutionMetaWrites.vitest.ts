import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import { finalizeRun, getRunRecords } from '@agent/storage';
import { aggregateId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
let session: ReturnType<typeof createTestSession>;
const id = 'bbb001';
beforeEach(async () => {
  session = createTestSession();
  publishTestRunStart(session, 'stream:metadata', id);
  await session.settlePublications();
});

describe('execution metadata updates', () => {
  it.effect(
    'preserves description and outcome when independent facts overlap',
    () =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            session.commit([
              {
                type: 'execution.description',
                aggregateId: aggregateId('execution', id),
                description: 'A described session',
              },
            ]),
            finalizeRun(session, {
              executionId: id,
              outcome: 'completed',
              flowRecord: 'preserve',
            }),
          ],
          { concurrency: 'unbounded' },
        );
        expect(yield* getRunRecords(session, id).readMeta()).toMatchObject({
          description: 'A described session',
          outcome: 'completed',
        });
      }),
  );
  it.effect('keeps a driver outcome when host-exit finalization follows', () =>
    Effect.gen(function* () {
      yield* finalizeRun(session, {
        executionId: id,
        outcome: 'completed',
        flowRecord: 'preserve',
      });
      yield* finalizeRun(session, {
        executionId: id,
        outcome: 'cancelled',
        flowRecord: 'preserve',
        keepExistingOutcome: true,
      });
      expect(yield* getRunRecords(session, id).readMeta()).toMatchObject({
        outcome: 'completed',
      });
    }),
  );
});
