// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import {
  cleanupAllCoordinatorRequests,
  resolvePlanApproval,
  resolveProposal,
  triggerRetry,
  waitForPlanApproval,
  waitForProposal,
  waitForRetry,
} from '@agent/runtime/runCoordinators';
import type { AgentLogger } from '@logger/AgentLogger';
import {
  AGENT_CATEGORY,
  TODO_STATUS,
  type AgentProposal,
  type Plan,
  type StreamTabId,
} from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:run-coordinator-test' as StreamTabId;
const plan: Plan = {
  summary: 'Move coordinator ownership into RunContext.',
  steps: [
    {
      title: 'Use run coordinator',
      description: 'Create interactive waits through the active run context.',
      status: TODO_STATUS.PENDING,
      files: ['src/agent/runtime/runCoordinators.ts'],
    },
  ],
};
const proposal: AgentProposal = {
  agentCategory: AGENT_CATEGORY.TOOL_USE,
  agent: 'reviewer',
  model: 'test-model',
  instruction: 'Review the runtime boundary.',
  memories: [],
};

function createCoordinators(host: AgentRuntimeHost): RunCoordinators {
  return {
    plan: new PlanApprovalCoordinator(host),
    proposal: new AgentProposalCoordinator(host),
    retry: new RetryRequestCoordinatorImpl(host),
  };
}

function createLogger(): AgentLogger {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  } as unknown as AgentLogger;
}

describe('runCoordinators', () => {
  afterEach(() => {
    cleanupAllCoordinatorRequests();
  });

  it('does not fall back to default coordinators when a run has none', async () => {
    const previousDefault = getDefaultAgentRuntimeHost();
    const active = createRecordingHost();
    const fallback = createRecordingHost();

    try {
      setDefaultAgentRuntimeHost(fallback.host);

      await withRunContext(
        createRunContext({ runtimeHost: active.host }),
        async () => {
          await expect(
            waitForPlanApproval(streamId, {
              approvalId: 'approval:missing-coordinators',
              plan,
            }),
          ).rejects.toThrow(/active run coordinators/);
          await expect(
            waitForProposal(streamId, {
              proposalId: 'proposal:missing-coordinators',
              proposal,
            }),
          ).rejects.toThrow(/active run coordinators/);
          await expect(
            waitForRetry(streamId, {
              operation: 'Model invocation',
              logger: createLogger(),
            }),
          ).rejects.toThrow(/active run coordinators/);
        },
      );

      expect(active.events).toEqual([]);
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });

  it('routes waits and resolver bridge events through active run coordinators', async () => {
    const previousDefault = getDefaultAgentRuntimeHost();
    const active = createRecordingHost();
    const fallback = createRecordingHost();
    const coordinators = createCoordinators(active.host);
    const context = createRunContext({
      runtimeHost: active.host,
      coordinators,
    });

    try {
      setDefaultAgentRuntimeHost(fallback.host);

      const planResult = withRunContext(context, () =>
        waitForPlanApproval(streamId, {
          approvalId: 'approval:active-coordinator',
          plan,
        }),
      );
      expect(
        resolvePlanApproval('approval:active-coordinator', {
          action: 'approve',
        }),
      ).toBe(true);
      await expect(planResult).resolves.toEqual({ action: 'approve' });

      const proposalResult = withRunContext(context, () =>
        waitForProposal(streamId, {
          proposalId: 'proposal:active-coordinator',
          proposal,
        }),
      );
      expect(
        resolveProposal('proposal:active-coordinator', {
          action: 'approve',
          agent: 'reviewer',
          model: 'test-model',
        }),
      ).toBe(true);
      await expect(proposalResult).resolves.toEqual({
        action: 'approve',
        agent: 'reviewer',
        model: 'test-model',
      });

      const retryResult = withRunContext(context, () =>
        waitForRetry(streamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );
      expect(triggerRetry(streamId, 'try the request again')).toBe(true);
      await expect(retryResult).resolves.toEqual({
        action: 'retry',
        feedback: 'try the request again',
      });

      expect(active.events.map((entry) => entry.event)).toEqual([
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
      ]);
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });
});
