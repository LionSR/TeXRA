// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import { humanGrant } from '@agent/runtime/runApprovalQueue';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { type BashPermission } from '@shared/schemas';
import {
  setTestApprovalPolicy,
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { closeSessionOf } from '@test/support/sessionEnd';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { requestBashApproval } from '@tools/approval/bashApproval';
import { generateRunId } from '@utils/core';

/** Watch bash requests in a scoped fiber, as a real host surface does. */
function watchBashRequests(session: SessionHandle) {
  return Effect.gen(function* () {
    const opened: BashPermission[] = [];
    const firstOpened = yield* Deferred.make<void>();
    const decisions: Array<() => void> = [];

    yield* Effect.forkScoped(
      Stream.runForEach(session.log.tail(session.log.now()), (event) =>
        Effect.gen(function* () {
          if (event.type !== 'request.opened') return;
          if (event.payload.kind !== 'bash') return;
          opened.push(event.payload.data);
          decisions.push(() =>
            publishTestRows(session, [
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
  // The project's policy is the fake host's setting, shared by the file.
  beforeEach(() => setTestApprovalPolicy('ask'));

  it.effect('lets never override a run bypass at the shared boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        const runId = generateRunId();
        let policyDenials = 0;
        yield* session.interactions.use({
          approvalDenied: () => {
            policyDenials += 1;
          },
        });
        setTestApprovalPolicy('never');
        publishTestRunStart(session, runId);
        yield* session.approvals.change(runId, humanGrant(['bash'], true));
        const requests = yield* watchBashRequests(session);

        const result = yield* requestBashApproval({
          command: 'echo denied',
          grant: 'shell',
        }).pipe(
          Effect.provide(
            nativeToolTestLayer({
              run: {
                runId,
                session,
                toolPolicy: {},
              },
            }),
          ),
        );

        expect(result).toEqual({
          action: 'deny',
          reason: 'Denied by the approval policy.',
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
          const session = yield* createTestSession();
          yield* Effect.addFinalizer(() => closeSessionOf(session));
          const runId = generateRunId();
          publishTestRunStart(session, runId);
          yield* session.log.settled;
          const requests = yield* watchBashRequests(session);

          const request = (command: string) =>
            requestBashApproval({ command, grant: 'shell' }).pipe(
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

          yield* session.approvals.change(runId, humanGrant(['bash'], true));
          requests.approve(0);

          expect(yield* Fiber.join(first)).toEqual({ action: 'approve' });
          expect(yield* Fiber.join(second)).toEqual({ action: 'approve' });
          expect(requests.opened).toHaveLength(1);
        }),
      ),
  );
});
