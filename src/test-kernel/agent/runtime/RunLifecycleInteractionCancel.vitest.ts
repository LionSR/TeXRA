// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type Plan,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

// Local file imports
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
  const executionId = `c${n.toString(16).padStart(5, '0')}` as ExecutionId;
  const streamId = `stream:run-cancel-${n}` as StreamTabId;
  const session = createTestSession();
  return {
    session,
    ctx: createTestLaunchContext({ executionId, streamId, session }),
    executionId,
    streamId,
  };
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
    const pending = session.interactions.requestPlanApproval({
      approvalId: 'approval:completed-run',
      streamId,
      plan,
      goalEnabled: false,
    });

    await runFlowWithLifecycle(ctx, async () => ({
      category: 'toolUse',
      outcome: RUN_OUTCOME.COMPLETED,
      executionId,
      streamId,
    }));

    await expect(pending).resolves.toEqual({
      action: 'reject',
      feedback: 'Run ended.',
    });
    session.dispose();
  });

  it('settles a pending approval when the runner throws', async () => {
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const pending = session.interactions.requestPlanApproval({
      approvalId: 'approval:failed-run',
      streamId,
      plan,
      goalEnabled: false,
    });

    await expect(
      runFlowWithLifecycle(ctx, async () => {
        throw new Error('flow exploded');
      }),
    ).rejects.toThrow('flow exploded');

    await expect(pending).resolves.toEqual({
      action: 'reject',
      feedback: 'Run ended.',
    });
    session.dispose();
  });

  it('settles a pending approval when the run parks at WAITING', async () => {
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const pending = session.interactions.requestPlanApproval({
      approvalId: 'approval:waiting-run',
      streamId,
      plan,
      goalEnabled: false,
    });

    const result = await runFlowWithLifecycle(ctx, async () => ({
      category: 'toolUse',
      outcome: STREAM_PHASE.WAITING,
      executionId,
      streamId,
    }));

    expect(result.outcome).toBe(STREAM_PHASE.WAITING);
    await expect(pending).resolves.toEqual({
      action: 'reject',
      feedback: 'Run ended.',
    });
    session.dispose();
  });

  it("leaves another stream's pending approval untouched", async () => {
    const { session, ctx, executionId, streamId } = lifecycleCase();
    const otherStreamId = `${streamId}:sibling` as StreamTabId;
    const sibling = session.interactions.requestPlanApproval({
      approvalId: 'approval:sibling-stream',
      streamId: otherStreamId,
      plan,
      goalEnabled: false,
    });
    let settled = false;
    void sibling.then(() => {
      settled = true;
    });

    await runFlowWithLifecycle(ctx, async () => ({
      category: 'toolUse',
      outcome: RUN_OUTCOME.COMPLETED,
      executionId,
      streamId,
    }));
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
          return {
            category: 'toolUse' as const,
            outcome: RUN_OUTCOME.COMPLETED,
            executionId,
            streamId,
          };
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
    const pending = session.interactions.requestPlanApproval({
      approvalId: 'approval:interrupted-run',
      streamId,
      plan,
      goalEnabled: false,
    });

    const result = await runFlowWithLifecycle(ctx, async () => {
      // What `flowContext.interrupt` does while the flow is still live.
      session.interactions.cancel({ streamId, cause: 'Run interrupted.' });
      return {
        category: 'toolUse' as const,
        outcome: RUN_OUTCOME.CANCELLED,
        executionId,
        streamId,
      };
    });

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    // The interrupt-time cancel wins; the lifecycle's second cancel matches no
    // pending request and cannot overwrite the settled feedback.
    await expect(pending).resolves.toEqual({
      action: 'reject',
      feedback: 'Run interrupted.',
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
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        })),
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
