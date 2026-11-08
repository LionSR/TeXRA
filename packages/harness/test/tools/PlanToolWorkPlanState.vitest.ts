// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Fiber, Layer, Context } from 'effect';
import { expect } from 'vitest';
import {
  APPROVAL_BYPASS_KINDS,
  generateRunId,
  type Plan,
  type RequestDecision,
  type RunId,
} from '@texra-ai/harness/schemas';
import { humanGrant } from '@agent/runtime/runApprovalQueue';

// Local imports
import { Inbox } from '@agent/followUp/Inbox';
import { Approvals } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';
import { PlanTool } from '@tools/plan/PlanTool';

// Local file imports
import {
  autoDecideRequests,
  createRecordingHost,
  decideRequest,
} from '@test/agent/progressTestUtils';

const followUpPlan: Plan = {
  objective: [
    'Implement the approved follow-up plan.',
    '',
    'Keep it gated after delegated work is approved.',
  ].join('\n'),
};

/**
 * A session whose plan requests park until the case answers them: the request
 * a run opens is a `request.opened` row, and a surface's `request.decide`
 * answers it (one run model, 3.7). Its request watcher stops with the
 * caller's scope.
 */
const planSession = Effect.fn('planSession')(function* (runId: RunId) {
  const { interactions } = createRecordingHost();
  const session = yield* isolatedTestSession(interactions);
  yield* publishTestRunStart(session, runId);
  const first = Promise.withResolvers<void>();
  const requests = yield* autoDecideRequests(session, () => {
    first.resolve();
    return null;
  });

  /** The plan request the tool opened, and the way to answer it. */
  const awaitPlanRequest = async () => {
    await first.promise;
    const opened = requests.opened[0];
    if (opened.payload.kind !== 'planApproval') {
      throw new Error(`Expected a plan request, not ${opened.payload.kind}.`);
    }
    const { requestId } = opened.payload.data;
    return {
      decide: (decision: RequestDecision) =>
        decideRequest(session, { runId, requestId }, decision),
    };
  };

  return { session, awaitPlanRequest };
});

/** The process, over a fresh default host for the test. */
const perTest = Layer.provideMerge(SessionGraph.layer, FakeHost.layer());

// Live clock: the plan request is opened and answered on the session's log.
layer(perTest, { buildPerTest: true, excludeTestServices: true })(
  'PlanTool — update (plan approval)',
  (it) => {
    it.effect(
      'keeps a later plan gated after delegated work approval is granted',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const runId = generateRunId();
            const { session, awaitPlanRequest } = yield* planSession(runId);

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => Context.get(session, Inbox).forget(runId)),
            );

            yield* Context.get(session, Approvals).change(
              runId,
              humanGrant(APPROVAL_BYPASS_KINDS, true),
            );

            const resultFiber = yield* Effect.forkScoped(
              PlanTool.call(followUpPlan).pipe(
                Effect.provide(
                  nativeToolTestLayer({
                    run: { runId, session, toolPolicy: {} },
                  }),
                ),
              ),
            );

            const { decide } = yield* Effect.tryPromise(() =>
              awaitPlanRequest(),
            );
            yield* decide({ action: 'approve' });
            expect((yield* Fiber.join(resultFiber)).status).toBe('executed');
          }),
        ),
    );
  },
);
