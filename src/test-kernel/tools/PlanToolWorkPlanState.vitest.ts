// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import type { PlanApprovalResult } from '@agent/runtime/HostInteractions';
import { platform, type Platform } from '@platform/platform';
import { planSummaryLine, GOAL_FEATURE_FLAG_KEY } from '@shared/schemas';
import type { Plan, StreamTabId } from '@shared/schemas';
import { withToolEnvironment } from '@test/support/toolEnvironment';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { GoalStore } from '@tools/goal';
import {
  cleanupApprovalsForStream,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';
import { PlanTool } from '@tools/plan/PlanTool';

// Local file imports
import {
  createRecordingHost,
  sessionWithInteractions,
  type RecordedProgressEvent,
  type RecordingHostDecisions,
} from '../agent/progressTestUtils';

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
  await installFakePlatform({ config: { [GOAL_FEATURE_FLAG_KEY]: flagOn } });
  return platform();
}

function startPlanUpdate(streamId: StreamTabId, objective: string) {
  const { decisions, events, interactions } = createRecordingHost();
  const session = sessionWithInteractions(interactions);
  const workPlanState = new WorkPlanState();
  const tool = new PlanTool();

  const resultPromise = withToolEnvironment(
    {
      run: {
        streamId,
        session,
      },
      call: {
        tracker: new FileInteractionState(),
        workPlanState,
      },
    },
    () => tool.call({ command: 'update', objective }),
  );

  return { decisions, resultPromise, events, session, workPlanState };
}

function findPlanApproval(
  events: RecordedProgressEvent[],
): RecordedProgressEvent {
  const approval = events.find((entry) => entry.event === 'showPlanApproval');
  expect(approval).toBeDefined();
  return approval!;
}

/** Submits a plan-approval decision for the request the tool showed. */
function submitPlanDecision(
  decisions: RecordingHostDecisions,
  approval: RecordedProgressEvent,
  decision: PlanApprovalResult,
): boolean {
  return decisions.submitPlan(
    (approval.payload as { approvalId: string }).approvalId,
    decision,
  );
}

describe('PlanTool — update (plan approval)', () => {
  it('keeps an approved plan in displayed work-plan state and defers steps to the todo tool', async () => {
    await installPlatform(false);
    const { decisions, resultPromise, events, workPlanState } = startPlanUpdate(
      'stream:plan-approve' as StreamTabId,
      plan.objective,
    );

    const approval = findPlanApproval(events);
    expect((approval.payload as { plan: Plan }).plan).toEqual(plan);
    expect(submitPlanDecision(decisions, approval, { action: 'approve' })).toBe(
      true,
    );

    const result = await resultPromise;
    expect(result.status).toBe('executed');
    expect(result.output).toContain('todo tool');
    expect(workPlanState.plan).toEqual(plan);
    expect(workPlanState.planSummary).toBe(planSummaryLine(plan.objective));
  });

  it('keeps a later plan gated after delegated work approval is granted', async () => {
    await installPlatform(false);
    const streamId = 'stream:plan-after-delegation-grant' as StreamTabId;
    const { decisions, events, interactions } = createRecordingHost();
    const session = sessionWithInteractions(interactions);
    const workPlanState = new WorkPlanState();

    try {
      session.approvals.setDelegatedWorkBypasses(streamId, true);
      expect(proposalApprovals(session).isBypassed(streamId)).toBe(true);

      const resultPromise = withToolEnvironment(
        {
          run: { streamId, session },
          call: {
            tracker: new FileInteractionState(),
            workPlanState,
          },
        },
        () => new PlanTool().call({ command: 'update', ...followUpPlan }),
      );

      const approval = findPlanApproval(events);
      expect((approval.payload as { plan: Plan }).plan).toEqual(followUpPlan);
      expect(
        submitPlanDecision(decisions, approval, { action: 'approve' }),
      ).toBe(true);
      await expect(resultPromise).resolves.toMatchObject({
        status: 'executed',
        summary: 'Plan approved: proceed with implementation',
      });
    } finally {
      cleanupApprovalsForStream(streamId, session);
    }
  });

  it('clears a rejected plan from displayed work-plan state', async () => {
    await installPlatform(false);
    const { decisions, resultPromise, events, workPlanState } = startPlanUpdate(
      'stream:plan-reject' as StreamTabId,
      plan.objective,
    );

    const approval = findPlanApproval(events);
    expect(
      submitPlanDecision(decisions, approval, {
        action: 'reject',
        feedback: 'Too broad.',
      }),
    ).toBe(true);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(workPlanState.plan).toBeNull();
    expect(workPlanState.planSummary).toBeNull();
  });

  it('does not attribute a lifecycle cancellation to the user', async () => {
    await installPlatform(false);
    const { decisions, resultPromise, events } = startPlanUpdate(
      'stream:plan-cancel' as StreamTabId,
      plan.objective,
    );

    const approval = findPlanApproval(events);
    expect(
      submitPlanDecision(decisions, approval, {
        action: 'reject',
        cause: 'CLI approval prompt failed.',
      }),
    ).toBe(true);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.summary).toBe('Plan approval cancelled');
    expect(result.error).toContain('CLI approval prompt failed.');
    expect(result.error).not.toContain('user rejected');
    expect(result.userInstruction).toBeUndefined();
  });

  it('approve_and_goal starts a goal using the plan document as the objective', async () => {
    const streamId = 'stream:plan-goal' as StreamTabId;
    await installPlatform(true);

    const { decisions, resultPromise, events, session } = startPlanUpdate(
      streamId,
      plan.objective,
    );
    try {
      const approval = findPlanApproval(events);
      expect((approval.payload as { goalEnabled: boolean }).goalEnabled).toBe(
        true,
      );
      expect(
        submitPlanDecision(decisions, approval, {
          action: 'approve_and_goal',
        }),
      ).toBe(true);

      const result = await resultPromise;
      expect(result.status).toBe('executed');

      const goal = GoalStore.getForStream(streamId);
      expect(goal).not.toBeNull();
      expect(goal!.status).toBe('active');
      // The approved plan document seeds the goal verbatim.
      expect(goal!.objective).toBe(plan.objective);
      expect(isBashApprovalBypassedForStream(streamId, session)).toBe(true);
      expect(isApprovalBypassedForStream(streamId, session)).toBe(false);
    } finally {
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId, session);
    }
  });

  it('approve_and_goal retargets an existing goal to the approved plan', async () => {
    const streamId = 'stream:plan-goal-retarget' as StreamTabId;
    await installPlatform(true);

    const existing = await GoalStore.start(streamId, 'Old objective');
    const { decisions, resultPromise, events, session } = startPlanUpdate(
      streamId,
      followUpPlan.objective,
    );
    try {
      const approval = findPlanApproval(events);
      expect(
        submitPlanDecision(decisions, approval, {
          action: 'approve_and_goal',
        }),
      ).toBe(true);

      const result = await resultPromise;
      expect(result.status).toBe('executed');
      expect(result.summary).toMatch(/retargeted/i);

      const goal = GoalStore.getForStream(streamId);
      expect(goal).not.toBeNull();
      expect(goal!.goalId).toBe(existing.goalId);
      expect(goal!.status).toBe('active');
      expect(goal!.objective).toBe(followUpPlan.objective);
      expect(goal!.objective).not.toContain('Old objective');
      expect(isBashApprovalBypassedForStream(streamId, session)).toBe(true);
      expect(isApprovalBypassedForStream(streamId, session)).toBe(false);
    } finally {
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId, session);
    }
  });

  it('approve_and_goal explicitly reports when goal is disabled before resolution', async () => {
    const streamId = 'stream:plan-goal-disabled' as StreamTabId;
    const platform = await installPlatform(true);

    try {
      const { decisions, resultPromise, events } = startPlanUpdate(
        streamId,
        plan.objective,
      );

      const approval = findPlanApproval(events);
      expect((approval.payload as { goalEnabled: boolean }).goalEnabled).toBe(
        true,
      );

      (platform.config as FakeConfigProvider).set(GOAL_FEATURE_FLAG_KEY, false);
      expect(
        submitPlanDecision(decisions, approval, {
          action: 'approve_and_goal',
        }),
      ).toBe(true);

      const result = await resultPromise;
      expect(result.status).toBe('executed');
      expect(result.summary).toMatch(/autonomous run unavailable/i);
      expect(result.output).toContain('feature flag is currently disabled');
      expect(GoalStore.getForStream(streamId)).toBeNull();
    } finally {
      await GoalStore.forget(streamId);
    }
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
    const tool = new PlanTool();
    return withToolEnvironment(
      {
        run: { streamId: STREAM_ID },
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
    expect(result.status).toBe('executed');
    expect(GoalStore.getForStream(STREAM_ID)?.status).toBe('paused');
  });

  it('completes an active goal by forgetting the record', async () => {
    await GoalStore.start(STREAM_ID, 'Drive the plan to completion.');
    const result = await callTool({
      command: 'complete',
      reason: 'Ran pnpm test; all 142 tests pass.',
    });
    expect(result.status).toBe('executed');
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
    expect(result.status).toBe('executed');
    expect(result.summary).toBe(
      'Plan-only work complete: summarize the result.',
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
    expect(result.status).toBe('executed');
    expect(result.summary).toBe('No autonomous goal to pause.');
    expect(result.output).toContain('ask the user directly');
  });

  it('rejects whitespace-only reason on pause', async () => {
    await GoalStore.start(STREAM_ID, 'objective');
    const result = await callTool({ command: 'pause', reason: '   ' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/empty/i);
  });
});
