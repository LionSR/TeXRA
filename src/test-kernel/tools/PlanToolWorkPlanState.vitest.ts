// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  FakeConfigProvider,
  createFakePlatform,
} from '@test/support/FakePlatform';
import {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/execution/AgentWorkspaceState';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { type RunCoordinators } from '@agent/runtime/RunContext';
import { withToolEnvironment } from '@agent/toolUse/ToolFileInteractionContext';
import type { Plan, StreamTabId } from '@shared/schemas';
import { GOAL_FEATURE_FLAG_KEY, GoalStore } from '@tools/goal';
import { PlanTool } from '@tools/plan/PlanTool';
import { createRecordingHost } from '../agent/progressTestUtils';

import type { Platform } from '@platform/platform';

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

const followUpPlan: Plan = {
  summary: 'Implement the approved follow-up plan.',
  steps: [
    {
      title: 'Retarget objective',
      description: 'Make the active goal follow the newly approved plan.',
      status: 'pending',
      files: ['src/tools/plan/PlanTool.ts'],
    },
  ],
};

async function installPlatform(flagOn: boolean): Promise<Platform> {
  const { initPlatform } = await import('@platform/platform');
  const platform = createFakePlatform({
    config: { [GOAL_FEATURE_FLAG_KEY]: flagOn },
  });
  initPlatform(platform);
  return platform;
}

describe('PlanTool — update (plan approval)', () => {
  it('clears a rejected plan from displayed work-plan state', async () => {
    await installPlatform(false);
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
      () => tool.call({ command: 'update', plan }),
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

  it('approve_and_goal starts a goal using the plan as the objective', async () => {
    const streamId = 'stream:plan-goal' as StreamTabId;
    await installPlatform(true);

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
        () => tool.call({ command: 'update', plan }),
      );

      const approval = events.find(
        (entry) => entry.event === 'showPlanApproval',
      );
      expect(approval).toBeDefined();
      expect((approval!.payload as { goalEnabled: boolean }).goalEnabled).toBe(
        true,
      );
      coordinator.resolveRequest(
        (approval!.payload as { approvalId: string }).approvalId,
        { action: 'approve_and_goal' },
      );

      const result = await resultPromise;
      expect(result.isError).not.toBe(true);

      const goal = GoalStore.getForStream(streamId);
      expect(goal).not.toBeNull();
      expect(goal!.status).toBe('active');
      expect(goal!.objective).toContain(plan.summary);
      expect(goal!.objective).toContain(plan.steps[0]!.title);
      expect(goal!.plan).toEqual(plan);
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('approve_and_goal retargets an existing goal to the approved plan', async () => {
    const streamId = 'stream:plan-goal-retarget' as StreamTabId;
    await installPlatform(true);

    try {
      const existing = await GoalStore.start(streamId, 'Old objective', {
        plan,
      });
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
        () => tool.call({ command: 'update', plan: followUpPlan }),
      );

      const approval = events.find(
        (entry) => entry.event === 'showPlanApproval',
      );
      expect(approval).toBeDefined();
      coordinator.resolveRequest(
        (approval!.payload as { approvalId: string }).approvalId,
        { action: 'approve_and_goal' },
      );

      const result = await resultPromise;
      expect(result.isError).not.toBe(true);
      expect(result.summary).toMatch(/retargeted/i);

      const goal = GoalStore.getForStream(streamId);
      expect(goal).not.toBeNull();
      expect(goal!.goalId).toBe(existing.goalId);
      expect(goal!.status).toBe('active');
      expect(goal!.objective).toContain(followUpPlan.summary);
      expect(goal!.objective).not.toContain('Old objective');
      expect(goal!.plan).toEqual(followUpPlan);
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('approve_and_goal explicitly reports when goal is disabled before resolution', async () => {
    const streamId = 'stream:plan-goal-disabled' as StreamTabId;
    const platform = await installPlatform(true);

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
        () => tool.call({ command: 'update', plan }),
      );

      const approval = events.find(
        (entry) => entry.event === 'showPlanApproval',
      );
      expect(approval).toBeDefined();
      expect((approval!.payload as { goalEnabled: boolean }).goalEnabled).toBe(
        true,
      );

      (platform.config as FakeConfigProvider).set(GOAL_FEATURE_FLAG_KEY, false);
      coordinator.resolveRequest(
        (approval!.payload as { approvalId: string }).approvalId,
        { action: 'approve_and_goal' },
      );

      const result = await resultPromise;
      expect(result.isError).not.toBe(true);
      expect(result.summary).toMatch(/autonomous run unavailable/i);
      expect(result.output).toContain('feature flag is currently disabled');
      expect(GoalStore.getForStream(streamId)).toBeNull();
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('clears a timed-out plan from displayed work-plan state', async () => {
    await installPlatform(false);
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
      () => tool.call({ command: 'update', plan }),
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

describe('PlanTool — pause/complete (goal lifecycle)', () => {
  const STREAM_ID = 'stream:plan-lifecycle' as StreamTabId;

  beforeEach(async () => {
    await installPlatform(true);
  });

  afterEach(async () => {
    await GoalStore.forget(STREAM_ID);
  });

  async function callTool(input: unknown) {
    const { host } = createRecordingHost();
    const tool = new PlanTool();
    return withToolEnvironment(
      {
        run: { runtimeHost: host, streamId: STREAM_ID },
        call: { tracker: new FileInteractionState() },
      },
      () => tool.call(input),
    );
  }

  it('pauses an active goal with a reason', async () => {
    await GoalStore.start(STREAM_ID, 'Drive the plan to completion.', {
      plan,
    });
    const result = await callTool({
      command: 'pause',
      reason: 'Need API credentials from the user.',
    });
    expect(result.isError).toBeFalsy();
    expect(GoalStore.getForStream(STREAM_ID)?.status).toBe('paused');
  });

  it('completes an active goal by forgetting the record', async () => {
    await GoalStore.start(STREAM_ID, 'Drive the plan to completion.', {
      plan,
    });
    const result = await callTool({
      command: 'complete',
      reason: 'Ran pnpm test; all 142 tests pass.',
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('all 142 tests pass');
    // Completing is `forget()` — a finished goal is not archived, so no
    // record remains and the wait-node loop has nothing to continue.
    expect(GoalStore.getForStream(STREAM_ID)).toBeNull();
  });

  it('complete is a no-op when no goal is running', async () => {
    const result = await callTool({
      command: 'complete',
      reason: 'I think I am done.',
    });
    expect(result.isError).toBeFalsy();
    expect(result.summary).toMatch(/no-op/i);
  });

  it('pause is a no-op when no goal is running', async () => {
    const result = await callTool({
      command: 'pause',
      reason: 'Need user input.',
    });
    expect(result.isError).toBeFalsy();
    expect(result.summary).toMatch(/no-op/i);
  });

  it('rejects whitespace-only reason on pause', async () => {
    await GoalStore.start(STREAM_ID, 'objective', { plan });
    const result = await callTool({ command: 'pause', reason: '   ' });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/empty/i);
  });
});
