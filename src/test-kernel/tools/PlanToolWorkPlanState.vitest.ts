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
import { planSummaryLine, type Plan, type StreamTabId } from '@shared/schemas';
import { GOAL_FEATURE_FLAG_KEY } from '@shared/schemas/goal';
import {
  cleanupApprovalsForStream,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
} from '@tools/approval';
import { GoalStore } from '@tools/goal';
import { PlanTool } from '@tools/plan/PlanTool';
import { createRecordingHost } from '../agent/progressTestUtils';

import type { Platform } from '@platform/platform';

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
    'Retarget the active goal at the newly approved objective.',
  ].join('\n'),
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
  it('keeps an approved plan in displayed work-plan state and defers steps to the todo tool', async () => {
    await installPlatform(false);
    const { events, host } = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
    const workPlanState = new WorkPlanState();
    const tool = new PlanTool();

    const resultPromise = withToolEnvironment(
      {
        run: {
          runtimeHost: host,
          streamId: 'stream:plan-approve' as StreamTabId,
          coordinators: { plan: coordinator } as unknown as RunCoordinators,
        },
        call: {
          tracker: new FileInteractionState(),
          workPlanState,
        },
      },
      () => tool.call({ command: 'update', objective: plan.objective }),
    );

    const approval = events.find((entry) => entry.event === 'showPlanApproval');
    expect(approval).toBeDefined();
    expect((approval!.payload as { plan: Plan }).plan).toEqual(plan);
    coordinator.resolveRequest(
      (approval!.payload as { approvalId: string }).approvalId,
      { action: 'approve' },
    );

    const result = await resultPromise;
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('todo tool');
    expect(workPlanState.plan).toEqual(plan);
    expect(workPlanState.planSummary).toBe(planSummaryLine(plan.objective));
  });

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
      () => tool.call({ command: 'update', objective: plan.objective }),
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

  it('approve_and_goal starts a goal using the plan document as the objective', async () => {
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
        () => tool.call({ command: 'update', objective: plan.objective }),
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
      // The approved plan document seeds the goal verbatim.
      expect(goal!.objective).toBe(plan.objective);
      expect(isBashApprovalBypassedForStream(streamId)).toBe(true);
      expect(isApprovalBypassedForStream(streamId)).toBe(false);
    } finally {
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
    }
  });

  it('approve_and_goal retargets an existing goal to the approved plan', async () => {
    const streamId = 'stream:plan-goal-retarget' as StreamTabId;
    await installPlatform(true);

    try {
      const existing = await GoalStore.start(streamId, 'Old objective');
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
        () =>
          tool.call({ command: 'update', objective: followUpPlan.objective }),
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
      expect(goal!.objective).toBe(followUpPlan.objective);
      expect(goal!.objective).not.toContain('Old objective');
      expect(isBashApprovalBypassedForStream(streamId)).toBe(true);
      expect(isApprovalBypassedForStream(streamId)).toBe(false);
    } finally {
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
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
        () => tool.call({ command: 'update', objective: plan.objective }),
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
      () => tool.call({ command: 'update', objective: plan.objective }),
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
    await GoalStore.start(STREAM_ID, 'Drive the plan to completion.');
    const result = await callTool({
      command: 'pause',
      reason: 'Need API credentials from the user.',
    });
    expect(result.isError).toBeFalsy();
    expect(GoalStore.getForStream(STREAM_ID)?.status).toBe('paused');
  });

  it('completes an active goal by forgetting the record', async () => {
    await GoalStore.start(STREAM_ID, 'Drive the plan to completion.');
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

  it('complete gives plan-only guidance when no goal is running', async () => {
    const result = await callTool({
      command: 'complete',
      reason: 'I think I am done.',
    });
    expect(result.isError).toBeFalsy();
    expect(result.summary).toBe(
      'Plan-only work complete — summarize the result.',
    );
    expect(result.output).toContain(
      'do not call plan(command="complete") again',
    );
  });

  it('pause gives direct-response guidance when no goal is running', async () => {
    const result = await callTool({
      command: 'pause',
      reason: 'Need user input.',
    });
    expect(result.isError).toBeFalsy();
    expect(result.summary).toBe('No autonomous goal to pause.');
    expect(result.output).toContain('ask the user directly');
  });

  it('rejects whitespace-only reason on pause', async () => {
    await GoalStore.start(STREAM_ID, 'objective');
    const result = await callTool({ command: 'pause', reason: '   ' });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/empty/i);
  });
});
