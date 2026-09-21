import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
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
    session
      .readView([])
      .pipe(Effect.map((view) => view.runs.get(runId)?.parentId ?? undefined)),
  );

describe('persisted parent edge', () => {
  it.effect('is absent for roots and for runs that were never started', () =>
    Effect.gen(function* () {
      publishTestRunStart(session, 'aaa001' as RunId);
      yield* session.settlePublications();
      expect(
        yield* Effect.promise(() => readParentRunId('aaa001' as RunId)),
      ).toBeUndefined();
      expect(
        yield* Effect.promise(() => readParentRunId('aaa002' as RunId)),
      ).toBeUndefined();
    }),
  );
  it.effect(
    'retains parent identity in the child creation even when reads exclude parent history',
    () =>
      Effect.gen(function* () {
        publishTestRunStart(session, 'aaa0ff' as RunId);
        yield* session.settlePublications();
        const rows = yield* session.commit([
          {
            type: 'run.start',
            aggregateId: aggregateId('run', 'aaa010' as RunId),
            identity: { kind: 'agent', agent: 'assistant' },
            category: 'toolUse',
            isRemote: false,
            userFollowUpSupport: 'unsupported',
            parent: { id: 'aaa0ff' as RunId },
          },
        ]);
        expect(rows[0]).toMatchObject({
          parent: { id: 'aaa0ff', startCommit: 1 },
        });
        const ownRows = yield* session.readRunRecords('aaa010' as RunId);
        expect(ownRows).toHaveLength(1);
        expect(
          yield* Effect.promise(() => readParentRunId('aaa010' as RunId)),
        ).toBe('aaa0ff');
      }),
  );
});
