import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
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
  await session.settlePublications();
});

describe('run metadata updates', () => {
  it('preserves description and outcome when independent facts overlap', async () => {
    await Effect.runPromise(
      Effect.all(
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
            flowRecord: 'preserve',
          }),
        ],
        { concurrency: 'unbounded' },
      ),
    );
    expect(
      (await Effect.runPromise(session.readView([id]))).runs.get(id),
    ).toMatchObject({
      description: 'A described session',
      status: 'completed',
    });
  });
  it('keeps a driver outcome when host-exit finalization follows', async () => {
    await Effect.runPromise(
      finalizeRun(session, {
        runId: id,
        outcome: 'completed',
        flowRecord: 'preserve',
      }),
    );
    await Effect.runPromise(
      finalizeRun(session, {
        runId: id,
        outcome: 'cancelled',
        flowRecord: 'preserve',
        keepExistingOutcome: true,
      }),
    );
    expect(
      await Effect.runPromise(getRunRecords(session, id).readRunEnd()),
    ).toMatchObject({ outcome: 'completed' });
  });
});
