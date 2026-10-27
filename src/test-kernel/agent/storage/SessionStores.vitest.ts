// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, SubscriptionRef } from 'effect';
import { describe, expect } from 'vitest';
import { registryOf } from '@agent/runtime/runRegistry';

// Local imports
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import { testRunHandle } from '@test/support/runHandleFixtures';
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
            yield* session.log.settled;
            const handle = testRunHandle({
              runId: child,
              parent,
              agent: 'chat',
            });
            registryOf(session.runs).track(handle);
            yield* session.log.settled;
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
            yield* session.log.settled;
            expect(
              SubscriptionRef.getUnsafe(session.view.ref).requests,
            ).toHaveLength(1);
            const before = session.log.now();
            publishTestRows(session, [
              {
                type: 'run.removed',
                aggregateId: qualifyAggregateId('run', parent),
              },
            ]);
            yield* session.log.settled;
            expect(
              SubscriptionRef.getUnsafe(session.view.ref).requests,
            ).toEqual([]);
            expect(registryOf(session.runs).parentOf(handle.runId)).not.toBe(
              parent,
            );
            expect(session.log.now()).toBe(before + 1);
          }),
        closeSessionOf,
      ),
  );
});
