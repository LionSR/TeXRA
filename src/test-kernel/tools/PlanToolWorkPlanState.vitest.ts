// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect } from 'vitest';
import { humanGrant } from '@agent/runtime/runApprovalQueue';

// Local imports
import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import type { Plan, RequestDecision, RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { PlanTool } from '@tools/plan/PlanTool';
import { generateRunId } from '@utils/core';

// Local file imports
import {
  autoDecideRequests,
  createRecordingHost,
  decideRequest,
  sessionWithInteractions,
} from '../agent/progressTestUtils';
import { waitForCondition } from '../support/asyncTestUtils';

const followUpPlan: Plan = {
  objective: [
    'Implement the approved follow-up plan.',
    '',
    'Keep it gated after delegated work is approved.',
  ].join('\n'),
};

/** Request watchers the cases opened, released after each. */
const cleanups: Array<() => void> = [];

/**
 * A session whose plan requests park until the case answers them: the request
 * a run opens is a `request.opened` row, and a surface's `request.decide`
 * answers it (one run model, 3.7).
 */
const planSession = Effect.fn('planSession')(function* (runId: RunId) {
  const { interactions } = createRecordingHost();
  const session = yield* sessionWithInteractions(interactions);
  publishTestRunStart(session, runId);
  const requests = autoDecideRequests(session, () => null);
  cleanups.push(() => requests.detach());

  /** The plan request the tool opened, and the way to answer it. */
  const awaitPlanRequest = async () => {
    await waitForCondition(() => requests.opened.length > 0, {
      timeoutMessage: 'Timed out waiting for the plan request to open',
    });
    const opened = requests.opened[0]!;
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

describe('PlanTool — update (plan approval)', () => {
  afterEach(() => {
    for (const release of cleanups.splice(0)) release();
  });

  it.live(
    'keeps a later plan gated after delegated work approval is granted',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => installFakePlatform());
          const runId = generateRunId();
          const { session, awaitPlanRequest } = yield* planSession(runId);

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => session.followUps.forget(runId)),
          );

          yield* session.approvals.change(
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

          const { decide } = yield* Effect.tryPromise(() => awaitPlanRequest());
          decide({ action: 'approve' });
          expect((yield* Fiber.join(resultFiber)).status).toBe('executed');
        }),
      ),
  );
});
