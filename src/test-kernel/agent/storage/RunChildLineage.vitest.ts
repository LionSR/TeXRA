import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });

describe('persisted parent edge', () => {
  it.effect(
    'retains parent identity in the child creation even when reads exclude parent history',
    () =>
      Effect.gen(function* () {
        const session = yield* createTestSession();
        publishTestRunStart(session, 'aaa0ff' as RunId);
        yield* session.log.settled;
        const rows = yield* session.log.transact([
          {
            type: 'run.start',
            aggregateId: qualifyAggregateId('run', 'aaa010' as RunId),
            identity: { kind: 'agent', agent: 'assistant' },
            userFollowUpSupport: 'unsupported',
            parent: { id: 'aaa0ff' as RunId, call: null },
            provenance: null,
          },
        ]);
        expect(rows[0]).toMatchObject({
          parent: { id: 'aaa0ff', uid: expect.any(String) },
        });
        const ownRows = yield* session.log.records('aaa010' as RunId);
        expect(ownRows).toHaveLength(1);
        const view = yield* session.view.read([]);
        expect(view.runs.get('aaa010' as RunId)?.parentId).toBe('aaa0ff');
      }),
  );
});
