// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import { platform, type Platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import { planSummaryLine, GOAL_FEATURE_FLAG_KEY } from '@shared/schemas';
import type { Plan, RequestDecision, RunId } from '@shared/schemas';
import { withToolEnvironment } from '@test/support/toolEnvironment';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { GoalStore } from '@tools/goal';
import { proposalApprovals, releaseRunResources } from '@tools/approval';
import { PlanTool } from '@tools/plan/PlanTool';
import { generateRunId } from '@utils/core';

// Local file imports
import {
  autoDecideRequests,
  createRecordingHost,
  decideRequest,
  sessionWithInteractions,
} from '../agent/progressTestUtils';
import { waitForCondition } from '../support/asyncTestUtils';

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

/** Request watchers the cases opened, released after each. */
const cleanups: Array<() => void> = [];

/**
 * A session whose plan requests park until the case answers them: the request
 * a run opens is a `request.opened` row, and a surface's `request.decide`
 * answers it (one run model, 3.7).
 */
function planSession(runId: RunId) {
  const { events, interactions } = createRecordingHost();
  const session = sessionWithInteractions(interactions);
  publishTestRunStart(session, runId);
  const requests = autoDecideRequests(session, () => null);
  cleanups.push(() => requests.detach());

  /** The plan request the tool opened, and the way to answer it. */
  const awaitPlanRequest = async () => {
    await waitForCondition(() => requests.opened.length > 0, {
      timeoutMessage: 'Timed out waiting for the plan request to open',
    });
    const opened = requests.opened[0]!;
    if (opened.payload.kind !== 'planApproval') {
      throw new Error(`Expected a plan request, not ${opened.payload.kind}.`);
    }
    const permission = opened.payload.data;
    return {
      permission,
      decide: (decision: RequestDecision) =>
        decideRequest(
          session,
          { runId, requestId: permission.requestId },
          decision,
        ),
    };
  };

  return { events, session, awaitPlanRequest };
}

async function startPlanUpdate(runId: RunId, objective: string) {
  const { events, session, awaitPlanRequest } = planSession(runId);
  const workPlanState = new WorkPlanState();
  const tool = new PlanTool();

  const resultPromise = withToolEnvironment(
    {
      run: {
        runId,
        session,
      },
      call: {
        tracker: new FileInteractionState(),
        workPlanState,
      },
    },
    () => tool.call({ command: 'update', objective }),
  );

  const { permission, decide } = await awaitPlanRequest();
  return { resultPromise, events, session, workPlanState, permission, decide };
}

describe('PlanTool — update (plan approval)', () => {
  afterEach(() => {
    for (const release of cleanups.splice(0)) release();
  });

  it('keeps an approved plan in displayed work-plan state and defers steps to the todo tool', async () => {
    await installPlatform(false);
    const { resultPromise, workPlanState, permission, decide } =
      await startPlanUpdate(generateRunId(), plan.objective);

    expect(permission.plan).toEqual(plan);
    decide({ action: 'approve' });

    const result = await resultPromise;
    expect(result.status).toBe('executed');
    expect(result.output).toContain('todo tool');
    expect(workPlanState.plan).toEqual(plan);
    expect(workPlanState.planSummary).toBe(planSummaryLine(plan.objective));
  });

  it('keeps a later plan gated after delegated work approval is granted', async () => {
    await installPlatform(false);
    const runId = generateRunId();
    const { session, awaitPlanRequest } = planSession(runId);
    const workPlanState = new WorkPlanState();

    try {
      session.approvals.setDelegatedWorkBypasses(runId, true);
      expect(proposalApprovals(session).isBypassed(runId)).toBe(true);

      const resultPromise = withToolEnvironment(
        {
          run: { runId, session },
          call: {
            tracker: new FileInteractionState(),
            workPlanState,
          },
        },
        () => new PlanTool().call({ command: 'update', ...followUpPlan }),
      );

      const { permission, decide } = await awaitPlanRequest();
      expect(permission.plan).toEqual(followUpPlan);
      decide({ action: 'approve' });
      await expect(resultPromise).resolves.toMatchObject({
        status: 'executed',
        summary: 'Plan approved: proceed with implementation',
      });
    } finally {
      releaseRunResources(runId, session);
    }
  });

  it('clears a rejected plan from displayed work-plan state', async () => {
    await installPlatform(false);
    const { resultPromise, workPlanState, decide } = await startPlanUpdate(
      generateRunId(),
      plan.objective,
    );

    decide({ action: 'reject', feedback: 'Too broad.' });

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(workPlanState.plan).toBeNull();
    expect(workPlanState.planSummary).toBeNull();
  });

  it('does not attribute a lifecycle cancellation to the user', async () => {
    await installPlatform(false);
    const { resultPromise, decide } = await startPlanUpdate(
      generateRunId(),
      plan.objective,
    );

    decide({ action: 'cancel', cause: 'CLI approval prompt failed.' });

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.summary).toBe('Plan approval cancelled');
    expect(result.error).toContain('CLI approval prompt failed.');
    expect(result.error).not.toContain('user rejected');
    expect(result.userInstruction).toBeUndefined();
  });

  it('approve_and_goal starts a goal using the plan document as the objective', async () => {
    const runId = generateRunId();
    await installPlatform(true);

    const { resultPromise, events, session, permission, decide } =
      await startPlanUpdate(runId, plan.objective);
    try {
      expect(permission.goalEnabled).toBe(true);
      decide({ action: 'approve_and_goal' });

      const result = await resultPromise;
      expect(result.status).toBe('executed');

      const goal = GoalStore.getForRun(runId);
      expect(goal).not.toBeNull();
      expect(goal!.status).toBe('active');
      // The approved plan document seeds the goal verbatim.
      expect(goal!.objective).toBe(plan.objective);
      expect(session.approvals.bash.bypass.isBypassed(runId)).toBe(true);
      expect(session.approvals.toolEdit.bypass.isBypassed(runId)).toBe(false);
      expect(
        events.filter((entry) => entry.event === 'setApprovalBypassState'),
      ).toEqual([
        {
          event: 'setApprovalBypassState',
          payload: { runId, kind: 'toolEdit', bypassActive: false },
        },
        {
          event: 'setApprovalBypassState',
          payload: { runId, kind: 'superYolo', bypassActive: false },
        },
        {
          event: 'setApprovalBypassState',
          payload: { runId, kind: 'bash', bypassActive: true },
        },
      ]);
    } finally {
      await GoalStore.forget(runId);
      releaseRunResources(runId, session);
    }
  });

  it('approve_and_goal applies the explicitly broadened approval scope', async () => {
    const runId = generateRunId();
    await installPlatform(true);

    const { resultPromise, events, session, decide } = await startPlanUpdate(
      runId,
      plan.objective,
    );
    try {
      decide({ action: 'approve_and_goal', autoApproveAll: true });

      await expect(resultPromise).resolves.toMatchObject({
        status: 'executed',
      });
      expect(session.approvals.bash.bypass.isBypassed(runId)).toBe(true);
      expect(session.approvals.toolEdit.bypass.isBypassed(runId)).toBe(true);
      expect(session.approvals.proposal.isBypassed(runId)).toBe(true);
      expect(
        events.filter((entry) => entry.event === 'setApprovalBypassState'),
      ).toEqual([
        {
          event: 'setApprovalBypassState',
          payload: { runId, kind: 'superYolo', bypassActive: true },
        },
        {
          event: 'setApprovalBypassState',
          payload: { runId, kind: 'toolEdit', bypassActive: true },
        },
        {
          event: 'setApprovalBypassState',
          payload: { runId, kind: 'bash', bypassActive: true },
        },
      ]);
    } finally {
      await GoalStore.forget(runId);
      releaseRunResources(runId, session);
    }
  });

  it('approve_and_goal retargets an existing goal to the approved plan', async () => {
    const runId = generateRunId();
    await installPlatform(true);

    const existing = await GoalStore.start(runId, 'Old objective');
    const { resultPromise, session, decide } = await startPlanUpdate(
      runId,
      followUpPlan.objective,
    );
    try {
      decide({ action: 'approve_and_goal' });

      const result = await resultPromise;
      expect(result.status).toBe('executed');
      expect(result.summary).toMatch(/retargeted/i);

      const goal = GoalStore.getForRun(runId);
      expect(goal).not.toBeNull();
      expect(goal!.goalId).toBe(existing.goalId);
      expect(goal!.status).toBe('active');
      expect(goal!.objective).toBe(followUpPlan.objective);
      expect(goal!.objective).not.toContain('Old objective');
      expect(session.approvals.bash.bypass.isBypassed(runId)).toBe(true);
      expect(session.approvals.toolEdit.bypass.isBypassed(runId)).toBe(false);
    } finally {
      await GoalStore.forget(runId);
      releaseRunResources(runId, session);
    }
  });

  it('approve_and_goal explicitly reports when goal is disabled before resolution', async () => {
    const runId = generateRunId();
    const platform = await installPlatform(true);

    try {
      const { resultPromise, permission, decide } = await startPlanUpdate(
        runId,
        plan.objective,
      );

      expect(permission.goalEnabled).toBe(true);

      (workspaceRoots().config as FakeConfigProvider).set(
        GOAL_FEATURE_FLAG_KEY,
        false,
      );
      decide({ action: 'approve_and_goal' });

      const result = await resultPromise;
      expect(result.status).toBe('executed');
      expect(result.summary).toMatch(/autonomous run unavailable/i);
      expect(result.output).toContain('feature flag is currently disabled');
      expect(GoalStore.getForRun(runId)).toBeNull();
    } finally {
      await GoalStore.forget(runId);
    }
  });
});

describe('PlanTool — pause/complete (goal lifecycle)', () => {
  const RUN_ID = generateRunId();

  beforeEach(async () => {
    await installPlatform(true);
  });

  afterEach(async () => {
    await GoalStore.forget(RUN_ID);
  });

  async function callTool(input: unknown) {
    const tool = new PlanTool();
    return withToolEnvironment(
      {
        run: { runId: RUN_ID },
        call: { tracker: new FileInteractionState() },
      },
      () => tool.call(input),
    );
  }

  it('pauses an active goal with a reason', async () => {
    await GoalStore.start(RUN_ID, 'Drive the plan to completion.');
    const result = await callTool({
      command: 'pause',
      reason: 'Need API credentials from the user.',
    });
    expect(result.status).toBe('executed');
    expect(GoalStore.getForRun(RUN_ID)?.status).toBe('paused');
  });

  it('completes an active goal by forgetting the record', async () => {
    await GoalStore.start(RUN_ID, 'Drive the plan to completion.');
    const result = await callTool({
      command: 'complete',
      reason: 'Ran pnpm test; all 142 tests pass.',
    });
    expect(result.status).toBe('executed');
    expect(result.output).toContain('all 142 tests pass');
    // Completing is `forget()` — a finished goal is not archived, so no
    // record remains and the wait-node loop has nothing to continue.
    expect(GoalStore.getForRun(RUN_ID)).toBeNull();
  });
});
