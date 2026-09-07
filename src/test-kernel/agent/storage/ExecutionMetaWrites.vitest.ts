import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { finalizeRun, getExecutionRecords } from '@agent/storage';
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
  it('preserves description and outcome when independent facts overlap', async () => {
    await Effect.runPromise(
      Effect.all(
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
      ),
    );
    expect(
      await Effect.runPromise(getExecutionRecords(session, id).readMeta()),
    ).toMatchObject({
      description: 'A described session',
      outcome: 'completed',
    });
  });
  it('keeps a driver outcome when host-exit finalization follows', async () => {
    await Effect.runPromise(
      finalizeRun(session, {
        executionId: id,
        outcome: 'completed',
        flowRecord: 'preserve',
      }),
    );
    await Effect.runPromise(
      finalizeRun(session, {
        executionId: id,
        outcome: 'cancelled',
        flowRecord: 'preserve',
        keepExistingOutcome: true,
      }),
    );
    expect(
      await Effect.runPromise(getExecutionRecords(session, id).readMeta()),
    ).toMatchObject({ outcome: 'completed' });
  });
});
