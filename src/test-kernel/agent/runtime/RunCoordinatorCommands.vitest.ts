import { describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import {
  cancelRuntimeRetry,
  resolveRuntimePlanApproval,
  resolveRuntimeProposal,
  triggerRuntimeRetry,
} from '@agent/runtime/runCoordinatorCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  AgentCategory,
  type AgentProposal,
  type Plan,
  type StreamTabId,
} from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const PLAN: Plan = {
  objective: 'Check the runtime coordinator command boundary.',
};

const PROPOSAL: AgentProposal = {
  agentCategory: AgentCategory.ToolUse,
  agent: 'reviewer',
  model: 'test-model',
  instruction: 'Review the proof.',
  memories: [],
};

function createCoordinators(host: AgentRuntimeHost): RunCoordinators {
  return {
    plan: new PlanApprovalCoordinator(host),
    proposal: new AgentProposalCoordinator(host),
    retry: new RetryRequestCoordinatorImpl(host),
  };
}

function createLogger(): AgentTrace {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  } as unknown as AgentTrace;
}

describe('runtime run-coordinator commands', () => {
  it('resolves approval and retry waits through the supplied session', async () => {
    const host = createRecordingHost();
    const session = new SessionHandle();
    const context = createRunContext({
      runtimeHost: host.host,
      coordinators: createCoordinators(host.host),
    });
    const streamId = 'coordinator-command-stream' as StreamTabId;

    try {
      const planResult = withRunContext(context, () =>
        session.coordinators.waitForPlanApproval(streamId, {
          approvalId: 'approval-1',
          plan: PLAN,
        }),
      );
      expect(
        resolveRuntimePlanApproval({
          approvalId: 'approval-1',
          result: { action: 'approve' },
          session,
        }),
      ).toBe(true);
      await expect(planResult).resolves.toEqual({ action: 'approve' });

      const proposalResult = withRunContext(context, () =>
        session.coordinators.waitForProposal(streamId, {
          proposalId: 'proposal-1',
          proposal: PROPOSAL,
        }),
      );
      expect(
        resolveRuntimeProposal({
          proposalId: 'proposal-1',
          result: { action: 'reject', feedback: 'Not now.' },
          session,
        }),
      ).toBe(true);
      await expect(proposalResult).resolves.toEqual({
        action: 'reject',
        feedback: 'Not now.',
      });

      const retryResult = withRunContext(context, () =>
        session.coordinators.waitForRetry(streamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );
      expect(
        triggerRuntimeRetry({
          streamId,
          feedback: 'Try with a smaller step.',
          session,
        }),
      ).toBe(true);
      await expect(retryResult).resolves.toEqual({
        action: 'retry',
        feedback: 'Try with a smaller step.',
      });

      const cancelledRetry = withRunContext(context, () =>
        session.coordinators.waitForRetry(streamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );
      expect(cancelRuntimeRetry({ streamId, session })).toBe(true);
      await expect(cancelledRetry).resolves.toEqual({ action: 'cancel' });

      expect(host.events.map((entry) => entry.event)).toEqual([
        'requestEnsureProgressView',
        'setActiveStream',
        'showPlanApproval',
        'resolvePlanApproval',
        'requestEnsureProgressView',
        'setActiveStream',
        'showAgentProposal',
        'resolveAgentProposal',
        'showRetryRequest',
        'resolveRetryRequest',
        'showRetryRequest',
        'resolveRetryRequest',
      ]);
    } finally {
      session.dispose();
    }
  });

  it('does not resolve a pending request owned by another session', async () => {
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const sessionA = new SessionHandle();
    const sessionB = new SessionHandle();
    const contextA = createRunContext({
      runtimeHost: hostA.host,
      coordinators: createCoordinators(hostA.host),
    });
    const contextB = createRunContext({
      runtimeHost: hostB.host,
      coordinators: createCoordinators(hostB.host),
    });
    const approvalId = 'shared-approval-id';

    try {
      const resultA = withRunContext(contextA, () =>
        sessionA.coordinators.waitForPlanApproval('stream-a', {
          approvalId,
          plan: PLAN,
        }),
      );
      const resultB = withRunContext(contextB, () =>
        sessionB.coordinators.waitForPlanApproval('stream-b', {
          approvalId,
          plan: PLAN,
        }),
      );

      expect(
        resolveRuntimePlanApproval({
          approvalId,
          result: { action: 'approve' },
          session: sessionA,
        }),
      ).toBe(true);
      await expect(resultA).resolves.toEqual({ action: 'approve' });
      expect(hostB.events.map((entry) => entry.event)).not.toContain(
        'resolvePlanApproval',
      );

      expect(
        resolveRuntimePlanApproval({
          approvalId,
          result: { action: 'reject', feedback: 'Later.' },
          session: sessionB,
        }),
      ).toBe(true);
      await expect(resultB).resolves.toEqual({
        action: 'reject',
        feedback: 'Later.',
      });
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('does not resolve same-id proposal or retry requests across sessions', async () => {
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const sessionA = new SessionHandle();
    const sessionB = new SessionHandle();
    const contextA = createRunContext({
      runtimeHost: hostA.host,
      coordinators: createCoordinators(hostA.host),
    });
    const contextB = createRunContext({
      runtimeHost: hostB.host,
      coordinators: createCoordinators(hostB.host),
    });
    const proposalId = 'shared-proposal-id';
    const retryStreamId = 'shared-retry-stream' as StreamTabId;

    try {
      const proposalA = withRunContext(contextA, () =>
        sessionA.coordinators.waitForProposal('proposal-stream-a', {
          proposalId,
          proposal: PROPOSAL,
        }),
      );
      const proposalB = withRunContext(contextB, () =>
        sessionB.coordinators.waitForProposal('proposal-stream-b', {
          proposalId,
          proposal: PROPOSAL,
        }),
      );

      expect(
        resolveRuntimeProposal({
          proposalId,
          result: {
            action: 'approve',
            agent: 'reviewer',
            model: 'test-model',
          },
          session: sessionA,
        }),
      ).toBe(true);
      await expect(proposalA).resolves.toEqual({
        action: 'approve',
        agent: 'reviewer',
        model: 'test-model',
      });
      expect(hostB.events.map((entry) => entry.event)).not.toContain(
        'resolveAgentProposal',
      );

      expect(
        resolveRuntimeProposal({
          proposalId,
          result: { action: 'reject', feedback: 'Use the other reviewer.' },
          session: sessionB,
        }),
      ).toBe(true);
      await expect(proposalB).resolves.toEqual({
        action: 'reject',
        feedback: 'Use the other reviewer.',
      });

      const retryA = withRunContext(contextA, () =>
        sessionA.coordinators.waitForRetry(retryStreamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );
      const retryB = withRunContext(contextB, () =>
        sessionB.coordinators.waitForRetry(retryStreamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );

      expect(
        triggerRuntimeRetry({
          streamId: retryStreamId,
          feedback: 'Retry A only.',
          session: sessionA,
        }),
      ).toBe(true);
      await expect(retryA).resolves.toEqual({
        action: 'retry',
        feedback: 'Retry A only.',
      });
      expect(
        hostB.events.filter((entry) => entry.event === 'resolveRetryRequest'),
      ).toEqual([]);

      expect(
        cancelRuntimeRetry({ streamId: retryStreamId, session: sessionB }),
      ).toBe(true);
      await expect(retryB).resolves.toEqual({ action: 'cancel' });
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });
});
