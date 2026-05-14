// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/AgentWorkspaceState';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type { Plan, StreamTabId } from '@shared/schemas';
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

    const resultPromise = withRunContext(
      createRunContext({
        runtimeHost: host,
        streamId: 'stream:plan-reject' as StreamTabId,
        coordinators: { plan: coordinator } as unknown as RunCoordinators,
      }),
      () =>
        withToolFileInteractionContext(
          {
            tracker: new FileInteractionState(),
            workPlanState,
          },
          () => tool.call({ plan }),
        ),
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

  it('clears a timed-out plan from displayed work-plan state', async () => {
    const { events, host } = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
    const workPlanState = new WorkPlanState();
    const tool = new PlanTool();

    const resultPromise = withRunContext(
      createRunContext({
        runtimeHost: host,
        streamId: 'stream:plan-timeout' as StreamTabId,
        coordinators: { plan: coordinator } as unknown as RunCoordinators,
      }),
      () =>
        withToolFileInteractionContext(
          {
            tracker: new FileInteractionState(),
            workPlanState,
          },
          () => tool.call({ plan }),
        ),
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
