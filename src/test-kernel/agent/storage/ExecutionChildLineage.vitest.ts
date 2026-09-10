import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import { hasPersistedParent } from '@agent/storage/executionLifecycle';
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
  it.effect('returns false for roots and absent executions', () =>
    Effect.gen(function* () {
      publishTestRunStart(session, 'root', 'aaa001');
      yield* Effect.promise(() => session.settlePublications());
      expect(yield* hasPersistedParent('aaa001', session)).toBe(false);
      expect(yield* hasPersistedParent('aaa002', session)).toBe(false);
    }),
  );
  it.effect(
    'retains parent identity in the child creation even when reads exclude parent history',
    () =>
      Effect.gen(function* () {
        publishTestRunStart(session, 'parent', 'aaa0ff');
        yield* Effect.promise(() => session.settlePublications());
        const rows = yield* session.commit([
          {
            type: 'run.start',
            aggregateId: aggregateId('stream', 'child'),
            executionId: 'aaa010',
            parentStreamId: 'parent',
            identity: { kind: 'agent', agent: 'assistant' },
            category: 'toolUse',
            isRemote: false,
            userFollowUpSupport: 'unsupported',
          },
        ]);
        expect(rows[0]).toMatchObject({
          parentExecutionId: 'aaa0ff',
          parentStartCommit: 1,
        });
        const ownRows = yield* session.readExecutionRecords('aaa010');
        expect(ownRows).toHaveLength(1);
        expect(yield* hasPersistedParent('aaa010', session)).toBe(true);
      }),
  );
});
