import { layer } from '@effect/vitest';
import { Effect, Context, Layer } from 'effect';
import { expect } from 'vitest';
import { qualifyAggregateId, type RunId } from '@texra-ai/harness/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

layer(
  Layer.provideMerge(
    SessionGraph.layer,
    FakeHost.layer({ workspacePath: '/workspace' }),
  ),
  { excludeTestServices: true },
)('persisted parent edge', (it) => {
  it.effect(
    'retains parent identity in the child creation even when reads exclude parent history',
    () =>
      Effect.gen(function* () {
        const session = yield* isolatedTestSession();
        publishTestRunStart(session, 'aaa0ff' as RunId);
        yield* Context.get(session, SessionLog).settled;
        const rows = yield* Context.get(session, SessionLog).transact([
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
        const facts = yield* Context.get(session, SessionLog).facts(
          'aaa010' as RunId,
        );
        expect(facts?.parent?.id).toBe('aaa0ff');
        const view = yield* Context.get(session, SessionViewAccess).read([]);
        expect(view.runs.get('aaa010' as RunId)?.parentId).toBe('aaa0ff');
      }),
  );
});
