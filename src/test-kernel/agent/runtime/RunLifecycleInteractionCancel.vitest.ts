import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, vi } from 'vitest';

import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type Plan,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createDeferred } from '@test/support/asyncTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeRun: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@agent/storage', () => ({
  finalizeRun: (...args: unknown[]) =>
    Effect.promise(() => storageMocks.finalizeRun(...args)),
}));

const plan: Plan = { objective: 'Finish the run.' };

let caseCounter = 0;

function lifecycleCase(): {
  session: SessionHandle;
  ctx: AgentLaunchContext;
  executionId: ExecutionId;
  streamId: StreamTabId;
} {
  const n = caseCounter++;
  const executionId = `exec:run-cancel-${n}` as ExecutionId;
  const streamId = `stream:run-cancel-${n}` as StreamTabId;
  const session = createTestSession();
  return {
    session,
    ctx: createTestLaunchContext({ executionId, streamId, session }),
    executionId,
    streamId,
  };
}

function requestApproval(
  session: SessionHandle,
  requestId: string,
  streamId: StreamTabId,
) {
  return session.interactions.requestPlanApproval({
    requestId,
    streamId,
    plan,
    goalEnabled: false,
  });
}

function toolUseRun<Outcome extends RunOutcome | typeof STREAM_PHASE.WAITING>(
  executionId: ExecutionId,
  streamId: StreamTabId,
  outcome: Outcome,
) {
  return { category: 'toolUse' as const, outcome, executionId, streamId };
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
 * `interactions.cancel({ streamId, cause: 'Run ended.' })` in their own
 * `finally`; these pin the one call site that replaced them, including the
 * exits neither flow reached the same way (throw, WAITING park).
 */
describe('run lifecycle host-interaction cancel', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });

  it.effect('settles a pending approval when the run completes', () =>
    Effect.gen(function* () {
      const { session, ctx, executionId, streamId } = lifecycleCase();
      const pending = requestApproval(
        session,
        'approval:completed-run',
        streamId,
      );

      yield* runFlowWithLifecycle(ctx, async () =>
        toolUseRun(executionId, streamId, RUN_OUTCOME.COMPLETED),
      );

      yield* Effect.promise(() => expectRunEndedRejection(pending));
      session.dispose();
    }),
  );

  it.effect(
    'settles and untracks the run after native interruption joins the active flow',
    () =>
      Effect.gen(function* () {
        const { session, ctx, executionId, streamId } = lifecycleCase();
        const started = createDeferred<AgentExecutionHandle>();
        const aborted = createDeferred();
        const released = createDeferred();
        const stopped = createDeferred();
        const fiber = yield* Effect.forkChild(
          runFlowWithLifecycle(ctx, async (handle) => {
            started.resolve(handle);
            ctx.runScope.signal.addEventListener(
              'abort',
              () => aborted.resolve(),
              { once: true },
            );
            await aborted.promise;
            await released.promise;
            stopped.resolve();
            return toolUseRun(executionId, streamId, RUN_OUTCOME.CANCELLED);
          }),
        );
        const handle = yield* Effect.promise(() => started.promise);
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.promise(() => aborted.promise);
        expect(ctx.disposeTrace).not.toHaveBeenCalled();
        released.resolve();
        yield* Fiber.join(interrupted);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true,
        );
        yield* Effect.promise(() => stopped.promise);
        expect(session.executions.getHandle(executionId)).toBeUndefined();
        expect(yield* handle.result).toMatchObject({
          outcome: RUN_OUTCOME.CANCELLED,
        });
        expect(ctx.disposeTrace).toHaveBeenCalledOnce();
        session.dispose();
      }),
  );

  it.effect('settles a pending approval when the runner throws', () =>
    Effect.gen(function* () {
      const { session, ctx, streamId } = lifecycleCase();
      const pending = requestApproval(session, 'approval:failed-run', streamId);

      const failure = yield* Effect.flip(
        runFlowWithLifecycle(ctx, async () => {
          throw new Error('flow exploded');
        }),
      );
      expect(failure.message).toContain('flow exploded');

      yield* Effect.promise(() => expectRunEndedRejection(pending));
      session.dispose();
    }),
  );

  it.effect('settles a pending approval when the run parks at WAITING', () =>
    Effect.gen(function* () {
      const { session, ctx, executionId, streamId } = lifecycleCase();
      const pending = requestApproval(
        session,
        'approval:waiting-run',
        streamId,
      );

      const result = yield* runFlowWithLifecycle(ctx, async () =>
        toolUseRun(executionId, streamId, STREAM_PHASE.WAITING),
      );

      expect(result.outcome).toBe(STREAM_PHASE.WAITING);
      yield* Effect.promise(() => expectRunEndedRejection(pending));
      session.dispose();
    }),
  );

  it.effect("leaves another stream's pending approval untouched", () =>
    Effect.gen(function* () {
      const { session, ctx, executionId, streamId } = lifecycleCase();
      const otherStreamId = `${streamId}:sibling` as StreamTabId;
      const sibling = requestApproval(
        session,
        'approval:sibling-stream',
        otherStreamId,
      );
      let settled = false;
      void sibling.then(() => {
        settled = true;
      });

      yield* runFlowWithLifecycle(ctx, async () =>
        toolUseRun(executionId, streamId, RUN_OUTCOME.COMPLETED),
      );
      yield* Effect.promise(() => Promise.resolve());

      expect(settled).toBe(false);
      session.dispose();
      expect(yield* Effect.promise(() => sibling)).toMatchObject({
        action: 'reject',
      });
    }),
  );

  it.effect(
    'cancels after the runner finishes unwinding, so a flow releases its follow-up queue first',
    () =>
      Effect.gen(function* () {
        const { session, ctx, executionId, streamId } = lifecycleCase();
        const order: string[] = [];
        const cancelSpy = vi
          .spyOn(session.interactions, 'cancel')
          .mockImplementation(() => {
            order.push('cancel');
          });

        try {
          yield* runFlowWithLifecycle(ctx, async () => {
            try {
              return toolUseRun(executionId, streamId, RUN_OUTCOME.COMPLETED);
            } finally {
              order.push('flow-teardown');
            }
          });

          expect(order).toEqual(['flow-teardown', 'cancel']);
          expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({
            streamId,
            cause: 'Run ended.',
          });
        } finally {
          cancelSpy.mockRestore();
          session.dispose();
        }
      }),
  );

  it.effect(
    'is harmless after an interrupt-time cancel already settled the approval',
    () =>
      Effect.gen(function* () {
        const { session, ctx, executionId, streamId } = lifecycleCase();
        const pending = requestApproval(
          session,
          'approval:interrupted-run',
          streamId,
        );

        const result = yield* runFlowWithLifecycle(ctx, async () => {
          // What `flowContext.interrupt` does while the flow is still live.
          session.interactions.cancel({ streamId, cause: 'Run interrupted.' });
          return toolUseRun(executionId, streamId, RUN_OUTCOME.CANCELLED);
        });

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
        // The interrupt-time cancel wins; the lifecycle's second cancel matches
        // no pending request and cannot overwrite the settled cause.
        expect(yield* Effect.promise(() => pending)).toEqual({
          action: 'reject',
          cause: 'Run interrupted.',
        });
        session.dispose();
      }),
  );

  it.effect(
    'keeps the published outcome when a host adapter throws on cancel',
    () =>
      Effect.gen(function* () {
        const { session, ctx, executionId, streamId } = lifecycleCase();
        const detach = session.interactions.use({
          cancel: () => {
            throw new Error('host cancel boom');
          },
        });

        try {
          expect(
            yield* runFlowWithLifecycle(ctx, async () =>
              toolUseRun(executionId, streamId, RUN_OUTCOME.COMPLETED),
            ),
          ).toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
          expect(session.status.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
          // The disposal below must not resurrect the throwing adapter's failure.
          expect(ctx.modelCell.handler.dispose).toHaveBeenCalledTimes(1);
        } finally {
          detach();
          session.dispose();
        }
      }),
  );
});
