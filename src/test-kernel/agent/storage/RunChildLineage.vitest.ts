import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { getRunRecords } from '@agent/storage';
import { aggregateId, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
let session: ReturnType<typeof createTestSession>;
beforeEach(() => {
  session = createTestSession();
});

const readParentRunId = (runId: RunId) =>
  Effect.runPromise(
    getRunRecords(session, runId)
      .readMeta()
      .pipe(Effect.map((meta) => meta?.parentRunId)),
  );

describe('persisted parent edge', () => {
  it('is absent for roots and for runs that were never started', async () => {
    publishTestRunStart(session, 'aaa001' as RunId);
    await session.settlePublications();
    expect(await readParentRunId('aaa001' as RunId)).toBeUndefined();
    expect(await readParentRunId('aaa002' as RunId)).toBeUndefined();
  });
  it('retains parent identity in the child creation even when reads exclude parent history', async () => {
    publishTestRunStart(session, 'aaa0ff' as RunId);
    await session.settlePublications();
    const rows = await Effect.runPromise(
      session.commit([
        {
          type: 'run.start',
          aggregateId: aggregateId('run', 'aaa010' as RunId),
          identity: { kind: 'agent', agent: 'assistant' },
          category: 'toolUse',
          isRemote: false,
          userFollowUpSupport: 'unsupported',
          parent: { id: 'aaa0ff' as RunId },
        },
      ]),
    );
    expect(rows[0]).toMatchObject({
      parent: { id: 'aaa0ff', startCommit: 1 },
    });
    const ownRows = await Effect.runPromise(
      session.readRunRecords('aaa010' as RunId),
    );
    expect(ownRows).toHaveLength(1);
    expect(await readParentRunId('aaa010' as RunId)).toBe('aaa0ff');
  });
});
