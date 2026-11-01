// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, SubscriptionRef, Context } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { qualifyAggregateId, type RunId } from '@texra-ai/harness/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { closeSessionOf } from '@test/support/sessionEnd';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';

describe('committed run removal', () => {
  it.live(
    'detaches a retained child when the session receives a committed parent removal',
    () =>
      Effect.acquireUseRelease(
        createTestSession(),
        (session) =>
          Effect.gen(function* () {
            const parent = 'aa0001' as RunId;
            const child = 'bb0002' as RunId;
            publishTestRunStart(session, parent);
            publishTestRunStart(session, child, { parent });
            yield* Context.get(session, SessionLog).settled;
            publishTestRows(session, [
              {
                type: 'request.opened',
                aggregateId: qualifyAggregateId('run', parent),
                requestId: 'question:removed-parent',
                payload: {
                  kind: 'userQuestion',
                  data: {
                    requestId: 'question:removed-parent',
                    runId: parent,
                    questions: [
                      {
                        question: 'Which normalization should be used?',
                        options: [
                          { label: 'Unit volume' },
                          { label: 'Unit mass' },
                        ],
                      },
                    ],
                    allowBypass: false,
                  },
                },
              },
            ]);
            yield* Context.get(session, SessionLog).settled;
            expect(
              SubscriptionRef.getUnsafe(
                Context.get(session, SessionViewAccess).ref,
              ).requests,
            ).toHaveLength(1);
            const before = Context.get(session, SessionLog).now();
            publishTestRows(session, [
              {
                type: 'run.removed',
                aggregateId: qualifyAggregateId('run', parent),
              },
            ]);
            yield* Context.get(session, SessionLog).settled;
            expect(
              SubscriptionRef.getUnsafe(
                Context.get(session, SessionViewAccess).ref,
              ).requests,
            ).toEqual([]);
            expect(
              Context.get(session, SessionViewAccess).run(child)?.parentId,
            ).not.toBe(parent);
            expect(Context.get(session, SessionLog).now()).toBe(before + 1);
          }),
        closeSessionOf,
      ),
  );
});
