// Regression coverage for #7306: a per-stream cancel must settle every
// approval kind on that stream, not only its retry routes.

import '@test/support/defaultSessionTestSetup';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: vi.fn(),
}));

// Approval prompt preparation reads per-stream bypass state off the process
// session; stub the session so these queue-focused tests need no
// initializeDefaultSession/platform setup.

import { SubscriptionRef } from 'effect';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { currentApproval } from '@cli/chat/tui/state/approvalQueue';
import { bindSessionView } from '@cli/chat/tui/state/sessionView';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  type AgentProposal,
  type Plan,
  type RunId,
} from '@shared/schemas';
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';
import {
  bashApprovalRequest,
  toolEditApprovalRequest,
} from '../agent/progressTestUtils';

function host(): CliRuntimeHost {
  return { emit: vi.fn() } as unknown as CliRuntimeHost;
}

/** The session's port with a fresh TUI host attached for the test; every
 *  request goes through the session, which publishes the fact the modal
 *  reads and settles the pending set. */

const runA = 'stream-a' as RunId;
const runB = 'stream-b' as RunId;

/**
 * The session's port for a test: a request names a run the fold must
 * already hold (only `run.start` mints one), so each hook first publishes
 * the run's existence fact when the view lacks it, then goes through the
 * session, which publishes `approval.requested` and settles the answer.
 */
function port(): SessionHostInteractions {
  const session = defaultSession();
  const ensureRun = (runId: string | null | undefined): void => {
    if (!runId) return;
    if (SubscriptionRef.getUnsafe(session.view).runs.has(runId as RunId))
      return;
    session.publish([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', runId as RunId),
        identity: { kind: 'agent', agent: 'agent' },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
        category: AgentCategory.ToolUse,
        isRemote: false,
        parent: null,
      },
    ]);
  };
  const port = session.interactions;
  return new Proxy(port, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const first = args[0] as { runId?: string | null } | undefined;
        if (
          (typeof key === 'string' && key.startsWith('request')) ||
          key === 'askUserQuestion' ||
          key === 'openExternalInquiry'
        ) {
          ensureRun(first?.runId);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as SessionHostInteractions;
}

function tuiInteractions(): SessionHostInteractions {
  const detach = defaultSession().interactions.use(
    createTuiHostInteractions(host(), createTuiCliContext()),
  );
  onTestFinished(detach);
  return port();
}

async function waitForApproval(
  kind: string,
  data: Record<string, unknown>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({ kind, data });
  });
}

const plan: Plan = { objective: 'Ship the fix.' };
const proposal: AgentProposal = {
  agentCategory: AgentCategory.ToolUse,
  agent: 'reviewer',
  model: 'test-model',
  instruction: 'Review the change.',
  memories: [],
};

beforeAll(() => {
  bindSessionView(defaultSession().view);
});
afterEach(() => {
  defaultSession().interactions.cancel({ cause: 'Session interrupted.' });
});

describe('createTuiHostInteractions', () => {
  it('forwards presentation events to the attached CLI presenter', () => {
    const presentationHost = host();
    const interactions = createTuiHostInteractions(
      presentationHost,
      createTuiCliContext(),
    );
    onTestFinished(() => interactions.dispose?.());

    interactions.emit?.('requestShowError', { message: 'Run failed.' });

    expect(presentationHost.emit).toHaveBeenCalledWith('requestShowError', {
      message: 'Run failed.',
    });
  });

  it('cancels a queued plan approval for the target stream, leaving other runs untouched', async () => {
    const interactions = tuiInteractions();
    const planResult = interactions.requestPlanApproval({
      requestId: 'approval-a',
      runId: runA,
      plan,
      goalEnabled: false,
    });
    const otherStreamResult = interactions.requestPlanApproval({
      requestId: 'approval-b',
      runId: runB,
      plan,
      goalEnabled: false,
    });

    await waitForApproval('planApproval', { runId: runA });

    interactions.cancel({
      runId: runA,
      cause: 'Session interrupted.',
    });

    await expect(planResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });

    // stream-b's request was never touched and now becomes the foreground
    // modal instead of being left permanently pending.
    await waitForApproval('planApproval', { runId: runB });
    currentApproval.get()?.decide({ accepted: true });
    await expect(otherStreamResult).resolves.toEqual({ action: 'approve' });
  });

  it('settles plan decisions through the shared mapper: goal action kept, silent rejection omits feedback', async () => {
    const interactions = tuiInteractions();
    const goalResult = interactions.requestPlanApproval({
      requestId: 'approval-goal',
      runId: runA,
      plan,
      goalEnabled: true,
    });
    await waitForApproval('planApproval', { runId: runA });
    currentApproval.get()?.decide({
      accepted: true,
      goalAutoApproveAll: true,
      planAction: 'approve_and_goal',
    });
    await expect(goalResult).resolves.toEqual({
      action: 'approve_and_goal',
      autoApproveAll: true,
    });

    const rejected = interactions.requestPlanApproval({
      requestId: 'approval-reject',
      runId: runA,
      plan,
      goalEnabled: false,
    });
    await waitForApproval('planApproval', { runId: runA });
    currentApproval.get()?.decide({ accepted: false });

    // A rejection without a user message omits `feedback` rather than
    // sending an explicit `undefined`.
    await expect(rejected).resolves.toEqual({ action: 'reject' });
  });

  it('cancels a queued agent proposal for the target stream', async () => {
    const interactions = tuiInteractions();
    const proposalResult = interactions.requestAgentProposal({
      requestId: 'proposal-a',
      runId: runA,
      ...proposal,
    });

    await waitForApproval('proposal', { runId: runA });

    interactions.cancel({
      runId: runA,
      cause: 'Session interrupted.',
    });

    await expect(proposalResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });
    await vi.waitFor(() => expect(currentApproval.get()).toBeUndefined());
  });

  it('cancels a queued bash approval for the target stream (not just retry)', async () => {
    const interactions = tuiInteractions();
    const bashResult = interactions.requestBashApproval(
      bashApprovalRequest({
        command: 'echo hi',
        runId: runA,
      }),
    );

    await waitForApproval('bash', { runId: runA });

    interactions.cancel({
      runId: runA,
      cause: 'Session interrupted.',
    });

    await expect(bashResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });
    await vi.waitFor(() => expect(currentApproval.get()).toBeUndefined());
  });

  it('keeps queued tool-edit cancellation separate from user feedback', async () => {
    const interactions = tuiInteractions();
    const editResult = interactions.requestToolEditApproval(
      toolEditApprovalRequest({
        path: '/work/paper.tex',
        originalContent: 'old',
        proposedContent: 'new',
        sourceTool: 'edit',
        runId: runA,
      }),
    );

    await waitForApproval('toolEdit', { runId: runA });
    interactions.cancel({
      runId: runA,
      cause: 'Session interrupted.',
    });

    await expect(editResult).resolves.toEqual({
      action: 'reject',
      cause: 'Session interrupted.',
    });
    await vi.waitFor(() => expect(currentApproval.get()).toBeUndefined());
  });

  it('an unfiltered cancel settles a live retry', async () => {
    const interactions = tuiInteractions();
    // requestRetry holds a queue reservation from before the modal appears
    // until its decision has been acted on; cancel({}) must settle that
    // entry, resolving the pending retry with 'cancel'.
    const retryResult = interactions.requestRetry({
      requestId: 'retry:first',
      runId: runA,
      operation: 'Model invocation',
    });

    await waitForApproval('retry', { runId: runA });

    interactions.cancel({ cause: 'All approvals cleared.' });

    await expect(retryResult).resolves.toEqual({ action: 'cancel' });
    await vi.waitFor(() => expect(currentApproval.get()).toBeUndefined());

    // The settled entry is gone from the queue: a stale decision cannot
    // resurrect it, and a fresh request reserves a fresh entry.
    const second = interactions.requestRetry({
      requestId: 'retry:second',
      runId: runA,
      operation: 'Model invocation',
    });
    await waitForApproval('retry', {});
    interactions.cancel({
      runId: runA,
      kind: 'retry',
      cause: 'Session interrupted.',
    });
    await expect(second).resolves.toEqual({ action: 'cancel' });
  });

  it('a retry-kind cancel leaves a queued plan approval on the same stream pending', async () => {
    const interactions = tuiInteractions();
    const planResult = interactions.requestPlanApproval({
      requestId: 'approval-kind',
      runId: runA,
      plan,
      goalEnabled: false,
    });

    await waitForApproval('planApproval', { runId: runA });

    interactions.cancel({
      runId: runA,
      kind: 'retry',
      cause: 'Session interrupted.',
    });

    // The plan approval is still the foreground modal and still decidable.
    expect(currentApproval.get()?.payload).toMatchObject({
      kind: 'planApproval',
      data: { runId: runA },
    });
    currentApproval.get()?.decide({ accepted: true });
    await expect(planResult).resolves.toEqual({ action: 'approve' });
  });
});
