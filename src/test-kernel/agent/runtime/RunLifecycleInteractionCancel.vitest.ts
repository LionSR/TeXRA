import { Cause, Effect, Exit, Fiber } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type Plan,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createDeferred } from '@test/support/asyncTestUtils';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeRun: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@agent/storage', () => ({
  finalizeRun: (...args: unknown[]) =>
    Effect.promise(() => storageMocks.finalizeRun(...args)),
}));

const plan: Plan = { objective: 'Finish the run.' };

/**
 * The lifecycle program over the fake host's process services. The suite runs
 * it on the default runtime rather than a process runtime, so the services it
 * requires are provided here.
 */
function runFlow(...args: Parameters<typeof runFlowWithLifecycle>) {
  return Effect.provide(runFlowWithLifecycle(...args), fakeProcessServices());
}

function lifecycleCase(): {
  session: SessionHandle;
  ctx: AgentLaunchContext;
  runId: RunId;
} {
  const runId = generateRunId();
  const session = createTestSession();
  return {
    session,
    ctx: createTestLaunchContext({ runId, session }),
    runId,
  };
}

function requestApproval(
  session: SessionHandle,
  requestId: string,
  runId: RunId,
) {
  return session.interactions.requestPlanApproval({
    requestId,
    runId,
    plan,
    goalEnabled: false,
  });
}

function toolUseRun<Outcome extends RunOutcome | typeof RUN_PHASE.WAITING>(
  runId: RunId,
  outcome: Outcome,
) {
  return {
    outcome,
    runId,
    output: { category: 'toolUse' as const, response: '', files: [] },
  };
}

async function expectRunEndedRejection(
  pending: Promise<unknown>,
): Promise<void> {
  await expect(pending).resolves.toEqual({
    action: 'reject',
    cause: 'Run ended.',
  });
}

/**
 * The run lifecycle is the single owner of the end-of-run host-interaction
 * cancel (stage 7 item 2). Both flows used to run an identical
 * `interactions.cancel({ runId, cause: 'Run ended.' })` in their own
 * `finally`; these pin the one call site that replaced them, including the
 * exits neither flow reached the same way (throw, WAITING park).
 */
describe('run lifecycle host-interaction cancel', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });

  it('settles a pending approval when the run completes', async () => {
    const { session, ctx, runId } = lifecycleCase();
    const pending = requestApproval(session, 'approval:completed-run', runId);

    await Effect.runPromise(
      runFlow(ctx, async () => toolUseRun(runId, RUN_OUTCOME.COMPLETED)),
    );

    await expectRunEndedRejection(pending);
    session.dispose();
  });

  it('settles and untracks the run after native interruption joins the active flow', async () => {
    const { session, ctx, runId } = lifecycleCase();
    const started = createDeferred();
    const aborted = createDeferred();
    const released = createDeferred();
    const stopped = createDeferred();
    const fiber = Effect.runFork(
      runFlow(ctx, async () => {
        started.resolve();
        ctx.runScope.signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        await aborted.promise;
        await released.promise;
        stopped.resolve();
        return toolUseRun(runId, RUN_OUTCOME.CANCELLED);
      }),
    );
    await started.promise;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await aborted.promise;
    expect(ctx.disposeTrace).not.toHaveBeenCalled();
    released.resolve();
    await interrupted;
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    await stopped.promise;
    expect(session.runs.getHandle(runId)).toBeUndefined();
    expect(session.status.get(runId)).toBe(RUN_PHASE.CANCELLED);
    expect(ctx.disposeTrace).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('settles a pending approval when the runner throws', async () => {
    const { session, ctx, runId } = lifecycleCase();
    const pending = requestApproval(session, 'approval:failed-run', runId);

    await expect(
      Effect.runPromise(
        runFlow(ctx, async () => {
          throw new Error('flow exploded');
        }),
      ),
    ).rejects.toThrow('flow exploded');

    await expectRunEndedRejection(pending);
    session.dispose();
  });

  it('settles a pending approval when the run parks at WAITING', async () => {
    const { session, ctx, runId } = lifecycleCase();
    const pending = requestApproval(session, 'approval:waiting-run', runId);

    const result = await Effect.runPromise(
      runFlow(ctx, async () => toolUseRun(runId, RUN_PHASE.WAITING)),
    );

    expect(result.outcome).toBe(RUN_PHASE.WAITING);
    await expectRunEndedRejection(pending);
    session.dispose();
  });

  it("leaves another run's pending approval untouched", async () => {
    const { session, ctx, runId } = lifecycleCase();
    const otherRunId = generateRunId();
    const sibling = requestApproval(
      session,
      'approval:sibling-run',
      otherRunId,
    );
    let settled = false;
    void sibling.then(() => {
      settled = true;
    });

    await Effect.runPromise(
      runFlow(ctx, async () => toolUseRun(runId, RUN_OUTCOME.COMPLETED)),
    );
    await Promise.resolve();

    expect(settled).toBe(false);
    session.dispose();
    await expect(sibling).resolves.toMatchObject({ action: 'reject' });
  });

  it('cancels after the runner finishes unwinding, so a flow releases its follow-up queue first', async () => {
    const { session, ctx, runId } = lifecycleCase();
    const order: string[] = [];
    const cancelSpy = vi
      .spyOn(session.interactions, 'cancel')
      .mockImplementation(() => {
        order.push('cancel');
      });

    try {
      await Effect.runPromise(
        runFlow(ctx, async () => {
          try {
            return toolUseRun(runId, RUN_OUTCOME.COMPLETED);
          } finally {
            order.push('flow-teardown');
          }
        }),
      );

      expect(order).toEqual(['flow-teardown', 'cancel']);
      expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({
        runId,
        cause: 'Run ended.',
      });
    } finally {
      cancelSpy.mockRestore();
      session.dispose();
    }
  });

  it('is harmless after an interrupt-time cancel already settled the approval', async () => {
    const { session, ctx, runId } = lifecycleCase();
    const pending = requestApproval(session, 'approval:interrupted-run', runId);

    const result = await Effect.runPromise(
      runFlow(ctx, async () => {
        // What `flowContext.interrupt` does while the flow is still live.
        session.interactions.cancel({ runId, cause: 'Run interrupted.' });
        return toolUseRun(runId, RUN_OUTCOME.CANCELLED);
      }),
    );

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    // The interrupt-time cancel wins; the lifecycle's second cancel matches no
    // pending request and cannot overwrite the settled cause.
    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: 'Run interrupted.',
    });
    session.dispose();
  });

  it('keeps the published outcome when a host adapter throws on cancel', async () => {
    const { session, ctx, runId } = lifecycleCase();
    const detach = session.interactions.use({
      cancel: () => {
        throw new Error('host cancel boom');
      },
    });

    try {
      await expect(
        Effect.runPromise(
          runFlow(ctx, async () => toolUseRun(runId, RUN_OUTCOME.COMPLETED)),
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      expect(session.status.get(runId)).toBe(RUN_PHASE.COMPLETED);
      // The disposal below must not resurrect the throwing adapter's failure.
      expect(ctx.modelCell.handler.dispose).toHaveBeenCalledTimes(1);
    } finally {
      detach();
      session.dispose();
    }
  });
});
