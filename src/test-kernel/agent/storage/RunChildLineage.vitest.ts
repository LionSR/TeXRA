import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasPersistedParent } from '@agent/storage/runLifecycle';
import { aggregateId } from '@shared/schemas';
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

describe('hasPersistedParent', () => {
  it('returns false for roots and absent executions', async () => {
    publishTestRunStart(session, 'root', 'aaa001');
    await session.settlePublications();
    expect(await Effect.runPromise(hasPersistedParent('aaa001', session))).toBe(
      false,
    );
    expect(await Effect.runPromise(hasPersistedParent('aaa002', session))).toBe(
      false,
    );
  });
  it('retains parent identity in the child creation even when reads exclude parent history', async () => {
    publishTestRunStart(session, 'parent', 'aaa0ff');
    await session.settlePublications();
    const rows = await Effect.runPromise(
      session.commit([
        {
          type: 'run.start',
          aggregateId: aggregateId('stream', 'child'),
          runId: 'aaa010',
          parentRunId: 'parent',
          identity: { kind: 'agent', agent: 'assistant' },
          category: 'toolUse',
          isRemote: false,
          userFollowUpSupport: 'unsupported',
        },
      ]),
    );
    expect(rows[0]).toMatchObject({
      parentRunId: 'aaa0ff',
      parentStartCommit: 1,
    });
    const ownRows = await Effect.runPromise(
      session.readRunRecords('aaa010'),
    );
    expect(ownRows).toHaveLength(1);
    expect(await Effect.runPromise(hasPersistedParent('aaa010', session))).toBe(
      true,
    );
  });
});
