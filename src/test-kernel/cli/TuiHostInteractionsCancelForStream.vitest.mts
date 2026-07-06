// Regression coverage for #7306 (cancelForStream only cancelled retry routes)
// and #7307 (requestPlanApproval/requestAgentProposal/requestRetry dropped
// HostInteractionOptions.timeoutMs). Both were flagged by bot review against
// PR #7303 and left unaddressed at merge.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: vi.fn(),
}));

import {
  clearApprovals,
  currentApproval,
} from '@cli/chat/tui/state/approvalQueue';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import { AgentCategory, type AgentProposal, type Plan } from '@shared/schemas';

function context(): CliContext {
  return {
    cwd: '/work',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    colorEnabled: false,
    version: 'test',
    resourcesPath: '/resources',
  };
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

afterEach(() => {
  clearApprovals();
});

describe('createTuiHostInteractions().cancelForStream', () => {
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

      interactions.cancelForStream('stream-a');

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

      interactions.cancelForStream('stream-a');

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

      interactions.cancelForStream('stream-a');

      await expect(bashResult).resolves.toEqual({
        accepted: false,
        userMessage: 'Session interrupted.',
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });
});

describe('HostInteractionOptions.timeoutMs threading', () => {
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
        { streamId: 'stream-a', operation: 'Model invocation' },
        { timeoutMs: 15 },
      );

      await expect(result).resolves.toEqual({ action: 'timeout' });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      interactions.dispose?.();
    }
  });
});
