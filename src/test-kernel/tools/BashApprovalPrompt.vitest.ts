// Third-party imports
import { layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, Stream, Context } from 'effect';
import { beforeEach, expect } from 'vitest';
import { type BashPermission, generateRunId } from '@texra-ai/harness/schemas';
import { humanGrant } from '@agent/runtime/runApprovalQueue';

// Local imports
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Interactions } from '@agent/runtime/HostInteractions';
import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import { SessionLog, Approvals } from '@shared/session/runHistory';
import {
  setTestApprovalPolicy,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';
import { commandTool } from '@test/agent/progressTestUtils';

/** Watch bash requests in a scoped fiber, as a real host surface does. */
function watchBashRequests(session: Context.Context<SessionServices>) {
  return Effect.gen(function* () {
    const opened: BashPermission[] = [];
    const firstOpened = yield* Deferred.make<void>();
    const decisions: Array<() => void> = [];

    yield* Effect.forkScoped(
      Stream.runForEach(
        Context.get(session, SessionLog).tail(
          Context.get(session, SessionLog).now(),
        ),
        (event) =>
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

// Live clock: the session's publisher and readers run on real turns.
layer(SessionGraph.layer, { excludeTestServices: true })(
  'command approval queueing',
  (it) => {
    // The project's policy is the fake host's setting, shared by the file.
    beforeEach(() => setTestApprovalPolicy('ask'));

    it.effect(
      'lets never override a run bypass and a hook allow at the shared boundary',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            const runId = generateRunId();
            let policyDenials = 0;
            yield* Context.get(session, Interactions).use({
              approvalDenied: () => {
                policyDenials += 1;
              },
            });
            setTestApprovalPolicy('never');
            publishTestRunStart(session, runId);
            yield* Context.get(session, Approvals).change(
              runId,
              humanGrant(['bash'], true),
            );
            const requests = yield* watchBashRequests(session);

            expect(
              Context.get(session, Approvals).permission(
                runId,
                'bash',
                'allow',
              ),
            ).toEqual({
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
            const session = yield* isolatedTestSession();
            const runId = generateRunId();
            publishTestRunStart(session, runId);
            yield* Context.get(session, SessionLog).settled;
            const requests = yield* watchBashRequests(session);

            const request = (command: string) =>
              guardedToolCall(commandTool, { command }).pipe(
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

            yield* Context.get(session, Approvals).change(
              runId,
              humanGrant(['bash'], true),
            );
            requests.approve(0);

            expect(yield* Fiber.join(first)).toMatchObject({
              status: 'executed',
            });
            expect(yield* Fiber.join(second)).toMatchObject({
              status: 'executed',
            });
            expect(requests.opened).toHaveLength(1);
          }),
        ),
    );
  },
);
