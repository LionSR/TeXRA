import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { aggregateId, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
let session: SessionHandle;
beforeEach(async () => {
  session = await Effect.runPromise(createTestSession());
});

const readParentRunId = (runId: RunId) =>
  Effect.runPromise(
    session
      .readView([])
      .pipe(Effect.map((view) => view.runs.get(runId)?.parentId ?? undefined)),
  );

describe('persisted parent edge', () => {
  it.effect(
    'retains parent identity in the child creation even when reads exclude parent history',
    () =>
      Effect.gen(function* () {
        publishTestRunStart(session, 'aaa0ff' as RunId);
        yield* session.settled;
        const rows = yield* session.commit([
          {
            type: 'run.start',
            aggregateId: aggregateId('run', 'aaa010' as RunId),
            identity: { kind: 'agent', agent: 'assistant' },
            userFollowUpSupport: 'unsupported',
            parent: { id: 'aaa0ff' as RunId, callId: null },
            provenance: null,
          },
        ]);
        expect(rows[0]).toMatchObject({
          parent: { id: 'aaa0ff', uid: expect.any(String) },
        });
        const ownRows = yield* session.readRunRecords('aaa010' as RunId);
        expect(ownRows).toHaveLength(1);
        expect(
          yield* Effect.promise(() => readParentRunId('aaa010' as RunId)),
        ).toBe('aaa0ff');
      }),
  );
});
