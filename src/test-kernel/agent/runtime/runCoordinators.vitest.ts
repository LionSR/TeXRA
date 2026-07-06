// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import type { AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import { RunCoordinatorBridge } from '@agent/runtime/runCoordinators';
import {
  AgentExecutionHandle,
  ExecutionRegistry,
} from '@agent/runtime/executionRegistry';
import {
  AgentCategory,
  type AgentProposal,
  type Plan,
  type StreamTabId,
} from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:run-coordinator-test' as StreamTabId;
const plan: Plan = {
  objective: [
    'Move coordinator ownership into RunContext.',
    '',
    'Create interactive waits through the active run context.',
  ].join('\n'),
};
const proposal: AgentProposal = {
  agentCategory: AgentCategory.ToolUse,
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

function createLogger(): AgentTrace {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  } as unknown as AgentTrace;
}

describe('runCoordinators', () => {
  it('does not fall back to default coordinators when a run has none', async () => {
    const active = createRecordingHost();
    const bridge = new RunCoordinatorBridge();

    await withRunContext(
      createRunContext({ runtimeHost: active.host }),
      async () => {
        await expect(
          bridge.waitForPlanApproval(streamId, {
            approvalId: 'approval:missing-coordinators',
            plan,
          }),
        ).rejects.toThrow(/active run coordinators/);
        await expect(
          bridge.waitForProposal(streamId, {
            proposalId: 'proposal:missing-coordinators',
            proposal,
          }),
        ).rejects.toThrow(/active run coordinators/);
        await expect(
          bridge.waitForRetry(streamId, {
            operation: 'Model invocation',
            logger: createLogger(),
          }),
        ).rejects.toThrow(/active run coordinators/);
      },
    );

    expect(active.events).toEqual([]);
  });

  it('routes waits and resolver bridge events through active run coordinators', async () => {
    const active = createRecordingHost();
    const bridge = new RunCoordinatorBridge();
    const coordinators = createCoordinators(active.host);
    const context = createRunContext({
      runtimeHost: active.host,
      coordinators,
    });

    const planResult = withRunContext(context, () =>
      bridge.waitForPlanApproval(streamId, {
        approvalId: 'approval:active-coordinator',
        plan,
      }),
    );
    expect(
      active.host.interactions?.resolve('approval:active-coordinator', {
        kind: 'plan',
        action: 'approve',
      }),
    ).toBe(true);
    await expect(planResult).resolves.toEqual({ action: 'approve' });

    const proposalResult = withRunContext(context, () =>
      bridge.waitForProposal(streamId, {
        proposalId: 'proposal:active-coordinator',
        proposal,
      }),
    );
    expect(
      active.host.interactions?.resolve('proposal:active-coordinator', {
        kind: 'proposal',
        action: 'approve',
        value: {
          action: 'approve',
          agent: 'reviewer',
          model: 'test-model',
        },
      }),
    ).toBe(true);
    await expect(proposalResult).resolves.toEqual({
      action: 'approve',
      agent: 'reviewer',
      model: 'test-model',
    });

    const retryResult = withRunContext(context, () =>
      bridge.waitForRetry(streamId, {
        operation: 'Model invocation',
        logger: createLogger(),
      }),
    );
    expect(bridge.triggerRetry(streamId, 'try the request again')).toBe(true);
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
  });

  it('cleans pending requests for one stream through their owning coordinators', async () => {
    const active = createRecordingHost();
    const registry = new ExecutionRegistry();
    const bridge = new RunCoordinatorBridge(registry);
    const coordinators = createCoordinators(active.host);
    const context = createRunContext({
      runtimeHost: active.host,
      coordinators,
    });
    const handle = new AgentExecutionHandle(
      'execution:cleanup-stream',
      streamId,
      streamId,
      'orchestrator',
      'toolUse',
      active.host,
      coordinators,
    );

    registry.track(handle);
    try {
      const planResult = withRunContext(context, () =>
        bridge.waitForPlanApproval(streamId, {
          approvalId: 'approval:cleanup-stream',
          plan,
        }),
      );
      const proposalResult = withRunContext(context, () =>
        bridge.waitForProposal(streamId, {
          proposalId: 'proposal:cleanup-stream',
          proposal,
        }),
      );
      const retryResult = withRunContext(context, () =>
        bridge.waitForRetry(streamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );

      bridge.cleanupRequestsForStream(streamId);

      await expect(planResult).resolves.toEqual({ action: 'reject' });
      await expect(proposalResult).resolves.toEqual({ action: 'reject' });
      await expect(retryResult).resolves.toEqual({ action: 'cancel' });
      expect(bridge.triggerRetry(streamId)).toBe(false);
      expect(
        active.host.interactions?.resolve('approval:cleanup-stream', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(false);
      expect(
        active.host.interactions?.resolve('proposal:cleanup-stream', {
          kind: 'proposal',
          action: 'approve',
        }),
      ).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('clears active-handle coordinator requests even without a bridge request index', async () => {
    const active = createRecordingHost();
    const registry = new ExecutionRegistry();
    const bridge = new RunCoordinatorBridge(registry);
    const coordinators = createCoordinators(active.host);
    const handle = new AgentExecutionHandle(
      'execution:direct-plan-clear',
      streamId,
      streamId,
      'orchestrator',
      'toolUse',
      active.host,
      coordinators,
    );

    registry.track(handle);
    try {
      const planResult = coordinators.plan.waitForApproval(streamId, {
        approvalId: 'approval:direct-plan-clear',
        plan,
      });

      bridge.clearPlanApprovalForStream(streamId);

      await expect(planResult).resolves.toEqual({ action: 'reject' });
      expect(
        active.host.interactions?.resolve('approval:direct-plan-clear', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(false);
    } finally {
      registry.dispose();
    }
  });
});
