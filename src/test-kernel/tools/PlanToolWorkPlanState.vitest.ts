// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { createFakePlatform } from '@test/support/FakePlatform';
import {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/AgentWorkspaceState';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { type RunCoordinators } from '@agent/runtime/RunContext';
import { withToolEnvironment } from '@agent/toolUse/ToolFileInteractionContext';
import type { Plan, StreamTabId } from '@shared/schemas';
import { ODYSSEY_FEATURE_FLAG_KEY, OdysseyStore } from '@tools/odyssey';
import { PlanTool } from '@tools/plan/PlanTool';
import { createRecordingHost } from '../agent/progressTestUtils';

const plan: Plan = {
  summary: 'Refactor the plan state boundary.',
  steps: [
    {
      title: 'Move ownership',
      description: 'Store plan progress in WorkPlanState.',
      status: 'pending',
      files: ['src/agent/core/AgentWorkspaceState.ts'],
    },
  ],
};

describe('PlanTool work-plan state', () => {
  it('clears a rejected plan from displayed work-plan state', async () => {
    const { events, host } = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
    const workPlanState = new WorkPlanState();
    const tool = new PlanTool();

    const resultPromise = withToolEnvironment(
      {
        run: {
          runtimeHost: host,
          streamId: 'stream:plan-reject' as StreamTabId,
          coordinators: { plan: coordinator } as unknown as RunCoordinators,
        },
        call: {
          tracker: new FileInteractionState(),
          workPlanState,
        },
      },
      () => tool.call({ plan }),
    );

    const approval = events.find((entry) => entry.event === 'showPlanApproval');
    expect(approval).toBeDefined();
    coordinator.resolveRequest(
      (approval!.payload as { approvalId: string }).approvalId,
      { action: 'reject', feedback: 'Too broad.' },
    );

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(workPlanState.plan).toBeNull();
    expect(workPlanState.planSummary).toBeNull();
  });

  it('approve_and_odyssey starts an odyssey using the plan as the objective', async () => {
    const streamId = 'stream:plan-odyssey' as StreamTabId;
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({ config: { [ODYSSEY_FEATURE_FLAG_KEY]: true } }),
    );

    try {
      const { events, host } = createRecordingHost();
      const coordinator = new PlanApprovalCoordinator(host);
      const workPlanState = new WorkPlanState();
      const tool = new PlanTool();

      const resultPromise = withToolEnvironment(
        {
          run: {
            runtimeHost: host,
            streamId,
            coordinators: { plan: coordinator } as unknown as RunCoordinators,
          },
          call: {
            tracker: new FileInteractionState(),
            workPlanState,
          },
        },
        () => tool.call({ plan }),
      );

      const approval = events.find(
        (entry) => entry.event === 'showPlanApproval',
      );
      expect(approval).toBeDefined();
      expect(
        (approval!.payload as { odysseyEnabled: boolean }).odysseyEnabled,
      ).toBe(true);
      coordinator.resolveRequest(
        (approval!.payload as { approvalId: string }).approvalId,
        { action: 'approve_and_odyssey' },
      );

      const result = await resultPromise;
      expect(result.isError).not.toBe(true);

      const odyssey = OdysseyStore.getForStream(streamId);
      expect(odyssey).not.toBeNull();
      expect(odyssey!.status).toBe('active');
      expect(odyssey!.objective).toContain(plan.summary);
      expect(odyssey!.objective).toContain(plan.steps[0]!.title);
      expect(odyssey!.plan).toEqual(plan);
    } finally {
      await OdysseyStore.forget(streamId);
    }
  });

  it('clears a timed-out plan from displayed work-plan state', async () => {
    const { events, host } = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
    const workPlanState = new WorkPlanState();
    const tool = new PlanTool();

    const resultPromise = withToolEnvironment(
      {
        run: {
          runtimeHost: host,
          streamId: 'stream:plan-timeout' as StreamTabId,
          coordinators: { plan: coordinator } as unknown as RunCoordinators,
        },
        call: {
          tracker: new FileInteractionState(),
          workPlanState,
        },
      },
      () => tool.call({ plan }),
    );

    const approval = events.find((entry) => entry.event === 'showPlanApproval');
    expect(approval).toBeDefined();
    coordinator.resolveRequest(
      (approval!.payload as { approvalId: string }).approvalId,
      { action: 'timeout' },
    );

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(workPlanState.plan).toBeNull();
    expect(workPlanState.planSummary).toBeNull();
  });
});
