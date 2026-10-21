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

const plan: Plan = {
  objective: [
    'Refactor the plan state boundary.',
    '',
    'Move plan progress ownership into WorkPlanState.',
    'Done when the workspace typechecks and the work-plan tests pass.',
  ].join('\n'),
};

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
    const permission = opened.payload.data;
    return {
      permission,
      decide: (decision: RequestDecision) =>
        decideRequest(
          session,
          { runId, requestId: permission.requestId },
          decision,
        ),
    };
  };

  return { session, awaitPlanRequest };
});

function startPlanUpdate(runId: RunId, objective: string) {
  return Effect.gen(function* () {
    const { session, awaitPlanRequest } = yield* planSession(runId);
    // The plans the run shows, in order: what its parent and its view read.
    const shown: (Plan | null)[] = [];
    const tool = PlanTool;

    const resultFiber = yield* Effect.forkScoped(
      tool.call({ objective }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              runId,
              session,
              toolPolicy: {},
              callbacks: {
                onProgress: (update) => {
                  if (update.kind === 'plan') shown.push(update.plan);
                },
              },
            },
          }),
        ),
      ),
    );

    const { permission, decide } = yield* Effect.tryPromise(() =>
      awaitPlanRequest(),
    );
    return {
      result: Fiber.join(resultFiber),
      session,
      shown,
      permission,
      decide,
    };
  });
}

describe('PlanTool — update (plan approval)', () => {
  afterEach(() => {
    for (const release of cleanups.splice(0)) release();
  });

  it.live('keeps an approved plan in displayed work-plan state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => installFakePlatform());
        const { result, shown, permission, decide } = yield* startPlanUpdate(
          generateRunId(),
          plan.objective,
        );

        expect(permission.plan).toEqual(plan);
        decide({ action: 'approve' });

        const outcome = yield* result;
        expect(outcome.status).toBe('executed');
        expect(outcome.output).toContain('Plan approved');
        expect(shown.at(-1)).toEqual(plan);
      }),
    ),
  );

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
          expect(session.approvals.bypass(runId, 'superYolo') !== null).toBe(
            true,
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

          const { permission, decide } = yield* Effect.tryPromise(() =>
            awaitPlanRequest(),
          );
          expect(permission.plan).toEqual(followUpPlan);
          decide({ action: 'approve' });
          expect(yield* Fiber.join(resultFiber)).toMatchObject({
            status: 'executed',
            summary: 'Plan approved: proceed with implementation',
          });
        }),
      ),
  );

  it.live('clears a rejected plan from displayed work-plan state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => installFakePlatform());
        const { result, shown, decide } = yield* startPlanUpdate(
          generateRunId(),
          plan.objective,
        );

        decide({ action: 'reject', feedback: 'Too broad.' });

        const outcome = yield* result;
        expect(outcome.status).toBe('error');
        expect(shown).toEqual([plan, null]);
      }),
    ),
  );

  it.live('does not attribute a lifecycle cancellation to the user', () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => installFakePlatform());
        const { result, decide } = yield* startPlanUpdate(
          generateRunId(),
          plan.objective,
        );

        decide({ action: 'cancel', cause: 'CLI approval prompt failed.' });

        const outcome = yield* result;
        expect(outcome.status).toBe('error');
        expect(outcome.summary).toBe('Plan approval cancelled');
        expect(outcome.error).toContain('CLI approval prompt failed.');
        expect(outcome.error).not.toContain('user rejected');
        expect(outcome.userInstruction).toBeUndefined();
      }),
    ),
  );
});
