import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
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
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn().mockResolvedValue({
    status: 'durable',
    terminalStatusPersisted: true,
    flowRecord: 'deleted',
  }),
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: storageMocks.finalizeExecution,
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
  approvalId: string,
  streamId: StreamTabId,
) {
  return session.interactions.requestPlanApproval({
    approvalId,
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

  it('settles a pending approval when the run completes', async () => {
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const pending = requestApproval(
      session,
      'approval:completed-run',
      streamId,
    );

    await runFlowWithLifecycle(ctx, async () =>
      toolUseRun(executionId, streamId, RUN_OUTCOME.COMPLETED),
    );

    await expectRunEndedRejection(pending);
    session.dispose();
  });

  it('settles a pending approval when the runner throws', async () => {
    const { session, ctx, streamId } = lifecycleCase();
    const pending = requestApproval(session, 'approval:failed-run', streamId);

    await expect(
      runFlowWithLifecycle(ctx, async () => {
        throw new Error('flow exploded');
      }),
    ).rejects.toThrow('flow exploded');

    await expectRunEndedRejection(pending);
    session.dispose();
  });

  it('settles a pending approval when the run parks at WAITING', async () => {
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const pending = requestApproval(session, 'approval:waiting-run', streamId);

    const result = await runFlowWithLifecycle(ctx, async () =>
      toolUseRun(executionId, streamId, STREAM_PHASE.WAITING),
    );

    expect(result.outcome).toBe(STREAM_PHASE.WAITING);
    await expectRunEndedRejection(pending);
    session.dispose();
  });

  it("leaves another stream's pending approval untouched", async () => {
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

    await runFlowWithLifecycle(ctx, async () =>
      toolUseRun(executionId, streamId, RUN_OUTCOME.COMPLETED),
    );
    await Promise.resolve();

    expect(settled).toBe(false);
    session.dispose();
    await expect(sibling).resolves.toMatchObject({ action: 'reject' });
  });

  it('cancels after the runner finishes unwinding, so a flow releases its follow-up queue first', async () => {
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const order: string[] = [];
    const cancelSpy = vi
      .spyOn(session.interactions, 'cancel')
      .mockImplementation(() => {
        order.push('cancel');
      });

    try {
      await runFlowWithLifecycle(ctx, async () => {
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
  });

  it('is harmless after an interrupt-time cancel already settled the approval', async () => {
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const pending = requestApproval(
      session,
      'approval:interrupted-run',
      streamId,
    );

    const result = await runFlowWithLifecycle(ctx, async () => {
      // What `flowContext.interrupt` does while the flow is still live.
      session.interactions.cancel({ streamId, cause: 'Run interrupted.' });
      return toolUseRun(executionId, streamId, RUN_OUTCOME.CANCELLED);
    });

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
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const detach = session.useHostInteractions({
      cancel: () => {
        throw new Error('host cancel boom');
      },
    });

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () =>
          toolUseRun(executionId, streamId, RUN_OUTCOME.COMPLETED),
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      expect(session.status.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
      // The disposal below must not resurrect the throwing adapter's failure.
      expect(ctx.modelCell.handler.dispose).toHaveBeenCalledTimes(1);
    } finally {
      detach();
      session.dispose();
    }
  });
});
