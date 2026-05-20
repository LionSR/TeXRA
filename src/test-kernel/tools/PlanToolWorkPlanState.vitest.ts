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
} from '@agent/core/AgentWorkspaceState';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { type RunCoordinators } from '@agent/runtime/RunContext';
import { withToolEnvironment } from '@agent/toolUse/ToolFileInteractionContext';
import type { Plan, StreamTabId } from '@shared/schemas';
import { ODYSSEY_FEATURE_FLAG_KEY, OdysseyStore } from '@tools/odyssey';
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
      description: 'Make the active odyssey follow the newly approved plan.',
      status: 'pending',
      files: ['src/tools/plan/PlanTool.ts'],
    },
  ],
};

async function installPlatform(flagOn: boolean): Promise<Platform> {
  const { initPlatform } = await import('@platform/platform');
  const platform = createFakePlatform({
    config: flagOn ? { [ODYSSEY_FEATURE_FLAG_KEY]: true } : {},
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

  it('approve_and_odyssey starts an odyssey using the plan as the objective', async () => {
    const streamId = 'stream:plan-odyssey' as StreamTabId;
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

  it('approve_and_odyssey retargets an existing odyssey to the approved plan', async () => {
    const streamId = 'stream:plan-odyssey-retarget' as StreamTabId;
    await installPlatform(true);

    try {
      const existing = await OdysseyStore.start(streamId, 'Old objective', {
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
        { action: 'approve_and_odyssey' },
      );

      const result = await resultPromise;
      expect(result.isError).not.toBe(true);
      expect(result.summary).toMatch(/retargeted/i);

      const odyssey = OdysseyStore.getForStream(streamId);
      expect(odyssey).not.toBeNull();
      expect(odyssey!.odysseyId).toBe(existing.odysseyId);
      expect(odyssey!.status).toBe('active');
      expect(odyssey!.objective).toContain(followUpPlan.summary);
      expect(odyssey!.objective).not.toContain('Old objective');
      expect(odyssey!.plan).toEqual(followUpPlan);
    } finally {
      await OdysseyStore.forget(streamId);
    }
  });

  it('approve_and_odyssey explicitly reports when odyssey is disabled before resolution', async () => {
    const streamId = 'stream:plan-odyssey-disabled' as StreamTabId;
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
      expect(
        (approval!.payload as { odysseyEnabled: boolean }).odysseyEnabled,
      ).toBe(true);

      (platform.config as FakeConfigProvider).set(
        ODYSSEY_FEATURE_FLAG_KEY,
        false,
      );
      coordinator.resolveRequest(
        (approval!.payload as { approvalId: string }).approvalId,
        { action: 'approve_and_odyssey' },
      );

      const result = await resultPromise;
      expect(result.isError).not.toBe(true);
      expect(result.summary).toMatch(/autonomous run unavailable/i);
      expect(result.output).toContain('feature flag is currently disabled');
      expect(OdysseyStore.getForStream(streamId)).toBeNull();
    } finally {
      await OdysseyStore.forget(streamId);
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

describe('PlanTool — pause/complete (odyssey lifecycle)', () => {
  const STREAM_ID = 'stream:plan-lifecycle' as StreamTabId;

  beforeEach(async () => {
    await installPlatform(true);
  });

  afterEach(async () => {
    await OdysseyStore.forget(STREAM_ID);
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

  it('pauses an active odyssey with a reason', async () => {
    await OdysseyStore.start(STREAM_ID, 'Drive the plan to completion.', {
      plan,
    });
    const result = await callTool({
      command: 'pause',
      reason: 'Need API credentials from the user.',
    });
    expect(result.isError).toBeFalsy();
    expect(OdysseyStore.getForStream(STREAM_ID)?.status).toBe('paused');
  });

  it('completes an active odyssey with a verification reason', async () => {
    await OdysseyStore.start(STREAM_ID, 'Drive the plan to completion.', {
      plan,
    });
    const result = await callTool({
      command: 'complete',
      reason: 'Ran pnpm test; all 142 tests pass.',
    });
    expect(result.isError).toBeFalsy();
    expect(OdysseyStore.getForStream(STREAM_ID)?.status).toBe('complete');
    expect(OdysseyStore.getForStream(STREAM_ID)?.completedReason).toContain(
      'all 142 tests pass',
    );
  });

  it('refuses to complete an abandoned odyssey', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective', { plan });
    await OdysseyStore.setStatus(STREAM_ID, 'abandoned', 'user abandoned');
    const result = await callTool({
      command: 'complete',
      reason: 'I think I am done.',
    });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/abandoned/i);
  });

  it('pause is a no-op when no odyssey is running', async () => {
    const result = await callTool({
      command: 'pause',
      reason: 'Need user input.',
    });
    expect(result.isError).toBeFalsy();
    expect(result.summary).toMatch(/no-op/i);
  });

  it('rejects whitespace-only reason on pause', async () => {
    await OdysseyStore.start(STREAM_ID, 'objective', { plan });
    const result = await callTool({ command: 'pause', reason: '   ' });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/empty/i);
  });
});
