// Regression coverage for #7306 (per-stream cancel only cancelled retry
// routes), flagged by bot review against PR #7303 and left unaddressed at
// merge.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: vi.fn(),
}));

// Approval prompt preparation reads per-stream bypass state off the process
// session; stub the session so these queue-focused tests need no
// initializeDefaultSession/platform setup.
vi.mock('@agent/runtime/SessionHandle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/runtime/SessionHandle')>();
  const bypass = { isBypassed: () => false, setBypass: vi.fn() };
  const session = {
    approvals: { bash: { bypass }, toolEdit: { bypass } },
    events: { emit: vi.fn() },
  };
  return {
    ...actual,
    currentSession: () => session,
    defaultSession: () => session,
  };
});

import {
  clearApprovals,
  currentApproval,
} from '@cli/chat/tui/state/approvalQueue';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { AgentCategory, type AgentProposal, type Plan } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

function context(): CliContext {
  return createTestCliContext({
    cwd: '/work',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    resourcesPath: '/resources',
  });
}

function host(): CliRuntimeHost {
  return { emit: vi.fn() } as unknown as CliRuntimeHost;
}

async function waitForApproval(
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({ kind, payload });
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
afterEach(() => {
  clearApprovals();
});

describe('createTuiHostInteractions', () => {
  it('forwards presentation events to the attached CLI presenter', () => {
    const presentationHost = host();
    const interactions = createTuiHostInteractions(presentationHost, context());
    try {
      interactions.emit?.('requestShowError', { message: 'Run failed.' });

      expect(presentationHost.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'Run failed.',
      });
    } finally {
      interactions.dispose?.();
    }
  });

  it('cancels a queued plan approval for the target stream, leaving other streams untouched', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const planResult = interactions.requestPlanApproval?.({
        approvalId: 'approval-a',
        streamId: 'stream-a',
        plan,
        goalEnabled: false,
      });
      const otherStreamResult = interactions.requestPlanApproval?.({
        approvalId: 'approval-b',
        streamId: 'stream-b',
        plan,
        goalEnabled: false,
      });

      await waitForApproval('planApproval', { streamId: 'stream-a' });

      interactions.cancel({ streamId: 'stream-a' });

      await expect(planResult).resolves.toEqual({
        action: 'reject',
        feedback: 'Session interrupted.',
      });

      // stream-b's request was never touched and now becomes the foreground
      // modal instead of being left permanently pending.
      await waitForApproval('planApproval', { streamId: 'stream-b' });
      currentApproval.get()?.decide({ accepted: true });
      await expect(otherStreamResult).resolves.toEqual({ action: 'approve' });
    } finally {
      interactions.dispose?.();
    }
  });

  it('settles plan decisions through the shared mapper: goal action kept, silent rejection omits feedback', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const goalResult = interactions.requestPlanApproval?.({
        approvalId: 'approval-goal',
        streamId: 'stream-a',
        plan,
        goalEnabled: true,
      });
      await waitForApproval('planApproval', { streamId: 'stream-a' });
      currentApproval.get()?.decide({
        accepted: true,
        planAction: 'approve_and_goal',
      });
      await expect(goalResult).resolves.toEqual({
        action: 'approve_and_goal',
      });

      const rejected = interactions.requestPlanApproval?.({
        approvalId: 'approval-reject',
        streamId: 'stream-a',
        plan,
        goalEnabled: false,
      });
      await waitForApproval('planApproval', { streamId: 'stream-a' });
      currentApproval.get()?.decide({ accepted: false });

      // A rejection without a user message omits `feedback` rather than
      // sending an explicit `undefined`.
      await expect(rejected).resolves.toStrictEqual({ action: 'reject' });
    } finally {
      interactions.dispose?.();
    }
  });

  it('cancels a queued agent proposal for the target stream', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const proposalResult = interactions.requestAgentProposal?.({
        proposalId: 'proposal-a',
        streamId: 'stream-a',
        ...proposal,
      });

      await waitForApproval('proposal', { streamId: 'stream-a' });

      interactions.cancel({ streamId: 'stream-a' });

      await expect(proposalResult).resolves.toEqual({
        action: 'reject',
        feedback: 'Session interrupted.',
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });

  it('cancels a queued bash approval for the target stream (not just retry)', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const bashResult = interactions.requestBashApproval?.({
        command: 'echo hi',
        streamId: 'stream-a',
      });

      await waitForApproval('bash', { streamId: 'stream-a' });

      interactions.cancel({ streamId: 'stream-a' });

      await expect(bashResult).resolves.toEqual({
        action: 'reject',
        feedback: 'Session interrupted.',
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });

  it('an unfiltered cancel settles active retry routes (pre-fold cleanupAllRequests parity)', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      // requestRetry registers a route in the retry-route registry before the
      // modal decision settles; cancel({}) must settle the route (resolving
      // the pending retry with 'cancel'), not just clear the modal queue.
      const retryResult = interactions.requestRetry?.({
        requestId: 'retry:first',
        streamId: 'stream-a',
        operation: 'Model invocation',
      });

      await waitForApproval('retry', { streamId: 'stream-a' });

      interactions.cancel({ cause: 'All approvals cleared.' });

      await expect(retryResult).resolves.toEqual({ action: 'cancel' });
      expect(currentApproval.get()).toBeUndefined();

      // The route registry entry is gone: a stale decision on the old route
      // cannot resurrect the retry (a fresh request gets a fresh route).
      const second = interactions.requestRetry?.({
        requestId: 'retry:second',
        streamId: 'stream-a',
        operation: 'Model invocation',
      });
      await waitForApproval('retry', {});
      interactions.cancel({ streamId: 'stream-a', kind: 'retry' });
      await expect(second).resolves.toEqual({ action: 'cancel' });
    } finally {
      interactions.dispose?.();
    }
  });

  it('a retry-kind cancel leaves a queued plan approval on the same stream pending', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const planResult = interactions.requestPlanApproval?.({
        approvalId: 'approval-kind',
        streamId: 'stream-a',
        plan,
        goalEnabled: false,
      });

      await waitForApproval('planApproval', { streamId: 'stream-a' });

      interactions.cancel({ streamId: 'stream-a', kind: 'retry' });

      // The plan approval is still the foreground modal and still decidable.
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'planApproval',
        payload: { streamId: 'stream-a' },
      });
      currentApproval.get()?.decide({ accepted: true });
      await expect(planResult).resolves.toEqual({ action: 'approve' });
    } finally {
      interactions.dispose?.();
    }
  });
});
