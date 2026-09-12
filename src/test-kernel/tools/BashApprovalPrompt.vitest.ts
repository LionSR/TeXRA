// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { BashPermission } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { requestBashApproval } from '@tools/approval/bashApproval';
import { generateRunId } from '@utils/core';

/** Watch bash requests in a scoped fiber, as a real host surface does. */
function watchBashRequests(session: SessionHandle) {
  return Effect.gen(function* () {
    const opened: BashPermission[] = [];
    const firstOpened = yield* Deferred.make<void>();
    const decisions: Array<() => void> = [];

    yield* Effect.forkScoped(
      Stream.runForEach(session.events.all(session.now()), (event) =>
        Effect.gen(function* () {
          if (event.type !== 'request.opened') return;
          if (event.payload.kind !== 'bash') return;
          opened.push(event.payload.data);
          decisions.push(() =>
            session.publish([
              {
                type: 'request.decided',
                aggregateId: event.aggregateId,
                requestId: event.requestId,
                decision: { action: 'approve' },
              },
            ]),
          );
          yield* Deferred.succeed(firstOpened, undefined);
        }),
      ),
    );

    return {
      opened,
      firstOpened: Deferred.await(firstOpened),
      approve: (index: number) => decisions[index]?.(),
    };
  });
}

describe('requestBashApproval queueing', () => {
  it.effect('lets never override a run bypass at the shared boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = createTestSession();
        yield* Effect.addFinalizer(() => Effect.sync(() => session.dispose()));
        const runId = generateRunId();
        let policyDenials = 0;
        session.setApprovalPolicy('never');
        session.approvals.bash.bypass.setBypass(runId, true, { silent: true });
        const requests = yield* watchBashRequests(session);

        const result = yield* requestBashApproval({
          command: 'echo denied',
        }).pipe(
          Effect.provide(
            nativeToolTestLayer({
              run: { runId, session, toolPolicy: {} },
              onApprovalPolicyDenial: () => {
                policyDenials += 1;
              },
            }),
          ),
        );

        expect(result).toEqual({
          action: 'deny',
          reason: 'Denied by TeXRA approval policy.',
        });
        expect(policyDenials).toBe(1);
        expect(requests.opened).toEqual([]);
      }),
    ),
  );

  it.effect(
    'auto-approves a queued request once the run is bypassed while it waits',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const session = createTestSession();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => session.dispose()),
          );
          const runId = generateRunId();
          publishTestRunStart(session, runId);
          yield* Effect.tryPromise(() => session.settlePublications());
          const requests = yield* watchBashRequests(session);

          const request = (command: string) =>
            requestBashApproval({ command }).pipe(
              Effect.provide(
                nativeToolTestLayer({
                  run: { runId, session, toolPolicy: {} },
                }),
              ),
            );

          const first = yield* Effect.forkScoped(request('echo first'));
          const second = yield* Effect.forkScoped(request('echo second'));
          yield* requests.firstOpened;
          expect(requests.opened.map(({ command }) => command)).toEqual([
            'echo first',
          ]);

          session.approvals.bash.bypass.setBypass(runId, true, {
            silent: true,
          });
          requests.approve(0);

          expect(yield* Fiber.join(first)).toEqual({ action: 'approve' });
          expect(yield* Fiber.join(second)).toEqual({ action: 'approve' });
          expect(requests.opened).toHaveLength(1);
        }),
      ),
  );
});
