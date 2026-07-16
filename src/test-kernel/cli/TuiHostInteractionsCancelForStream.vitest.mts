// Regression coverage for #7306 (per-stream cancel only cancelled retry routes)
// and #7307 (requestPlanApproval/requestAgentProposal/requestRetry dropped
// HostInteractionOptions.timeoutMs). Both were flagged by bot review against
// PR #7303 and left unaddressed at merge.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: vi.fn(),
}));

import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  clearApprovals,
  currentApproval,
} from '@cli/chat/tui/state/approvalQueue';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import {
  AgentCategory,
  type AgentProposal,
  type Plan,
  type UserQuestionPermission,
} from '@shared/schemas';

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

const plan: Plan = { objective: 'Ship the fix.' };
const proposal: AgentProposal = {
  agentCategory: AgentCategory.ToolUse,
  agent: 'reviewer',
  model: 'test-model',
  instruction: 'Review the change.',
  memories: [],
};
const question: UserQuestionPermission = {
  requestId: 'question-timeout',
  allowBypass: false,
  streamId: 'stream-a',
  questions: [
    {
      question: 'Continue?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    },
  ],
};

afterEach(() => {
  clearApprovals();
});

describe('createTuiHostInteractions().cancel', () => {
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

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'plan',
          payload: { streamId: 'stream-a' },
        });
      });

      interactions.cancel({ streamId: 'stream-a' });

      await expect(planResult).resolves.toEqual({
        action: 'reject',
        feedback: 'Session interrupted.',
      });

      // stream-b's request was never touched and now becomes the foreground
      // modal instead of being left permanently pending.
      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'plan',
          payload: { streamId: 'stream-b' },
        });
      });
      currentApproval.get()?.decide({ accepted: true });
      await expect(otherStreamResult).resolves.toEqual({ action: 'approve' });
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

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'proposal',
          payload: { streamId: 'stream-a' },
        });
      });

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

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'bash',
          payload: { streamId: 'stream-a' },
        });
      });

      interactions.cancel({ streamId: 'stream-a' });

      await expect(bashResult).resolves.toEqual({
        accepted: false,
        userMessage: 'Session interrupted.',
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

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { streamId: 'stream-a' },
        });
      });

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
      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
        });
      });
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

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'plan',
          payload: { streamId: 'stream-a' },
        });
      });

      interactions.cancel({ streamId: 'stream-a', kind: 'retry' });

      // The plan approval is still the foreground modal and still decidable.
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'plan',
        payload: { streamId: 'stream-a' },
      });
      currentApproval.get()?.decide({ accepted: true });
      await expect(planResult).resolves.toEqual({ action: 'approve' });
    } finally {
      interactions.dispose?.();
    }
  });
});

describe('HostInteractionOptions.timeoutMs threading', () => {
  it('accepts a positive fractional timeout', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const result = interactions.requestPlanApproval?.(
        {
          approvalId: 'approval-fractional-timeout',
          streamId: 'stream-a',
          plan,
          goalEnabled: false,
        },
        { timeoutMs: 0.5 },
      );

      await expect(result).resolves.toEqual({ action: 'timeout' });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });

  it('times out a plan approval that outlives timeoutMs without user input', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const result = interactions.requestPlanApproval?.(
        {
          approvalId: 'approval-timeout',
          streamId: 'stream-a',
          plan,
          goalEnabled: false,
        },
        { timeoutMs: 15 },
      );

      await expect(result).resolves.toEqual({ action: 'timeout' });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });

  it('times out an agent proposal that outlives timeoutMs without user input', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const result = interactions.requestAgentProposal?.(
        { proposalId: 'proposal-timeout', streamId: 'stream-a', ...proposal },
        { timeoutMs: 15 },
      );

      await expect(result).resolves.toEqual({ action: 'timeout' });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });

  it('times out a retry request that outlives timeoutMs without user input', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const result = interactions.requestRetry?.(
        {
          requestId: 'retry:timeout',
          streamId: 'stream-a',
          operation: 'Model invocation',
        },
        { timeoutMs: 15 },
      );

      await expect(result).resolves.toEqual({ action: 'timeout' });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });

  it('times out a bash approval that outlives timeoutMs without user input', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const result = interactions.requestBashApproval?.(
        { command: 'echo hi', streamId: 'stream-a' },
        { timeoutMs: 15 },
      );

      // #7444: the timeout carries a distinct `timedOut: true` flag so it
      // doesn't collapse into the same shape as an explicit user rejection.
      await expect(result).resolves.toEqual({
        accepted: false,
        userMessage: 'Approval request timed out.',
        timedOut: true,
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });

  it('times out a user question that outlives timeoutMs without user input', async () => {
    const interactions = createTuiHostInteractions(host(), context());
    try {
      const result = interactions.askUserQuestion?.(question, {
        timeoutMs: 15,
      });

      await expect(result).resolves.toEqual({
        submitted: false,
        feedback: 'Approval request timed out.',
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });
});
