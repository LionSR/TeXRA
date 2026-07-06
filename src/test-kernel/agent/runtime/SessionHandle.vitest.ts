// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { getActiveFlushers, getDefaultStreamLogStore } from '@transcript';
import type { AgentTrace } from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import {
  SessionHandle,
  defaultSession,
  getAllActiveExecutionIds,
} from '@agent/runtime/SessionHandle';
import {
  AgentExecutionHandle,
  executionRegistry,
} from '@agent/runtime/executionRegistry';
import { interruptRegistry } from '@agent/runtime/InterruptRegistry';
import { runCoordinatorBridge } from '@agent/runtime/runCoordinators';
import { executionSubscriptionBinder } from '@agent/runtime/ExecutionSubscriptionBinder';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { type Plan, type StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const plan: Plan = { objective: 'Compose the per-session runtime owners.' };

function createCoordinators(host: AgentRuntimeHost): RunCoordinators {
  return {
    plan: new PlanApprovalCoordinator(host),
    proposal: new AgentProposalCoordinator(host),
    retry: new RetryRequestCoordinatorImpl(host),
  };
}

function createLogger(): AgentTrace {
  return { debug: vi.fn(), warn: vi.fn() } as unknown as AgentTrace;
}

function trackAgent(
  session: SessionHandle,
  host: AgentRuntimeHost,
  coordinators: RunCoordinators,
  executionId: string,
  streamId: StreamTabId,
): AgentExecutionHandle {
  const handle = new AgentExecutionHandle(
    executionId,
    streamId,
    streamId,
    'orchestrator',
    'toolUse',
    host,
    coordinators,
  );
  session.executions.track(handle);
  return handle;
}

describe('SessionHandle', () => {
  it('defaultSession wraps the process singletons by identity', () => {
    expect(defaultSession().interrupts).toBe(interruptRegistry);
    expect(defaultSession().executions).toBe(executionRegistry);
    expect(defaultSession().coordinators).toBe(runCoordinatorBridge);
    expect(defaultSession().subscriptions).toBe(executionSubscriptionBinder);
    expect(defaultSession().status).toBe(StreamStatusService);
    expect(defaultSession().events).toBeDefined();
    expect(defaultSession().transcripts).toBe(getDefaultStreamLogStore());
    expect(defaultSession().followUps).toBe(
      ToolUseFollowUpQueue.defaultInstance(),
    );
    expect(defaultSession().flushers).toBe(getActiveFlushers());
    expect(defaultSession().hostChannel).toBeUndefined();
  });

  it('a fresh session shares no member with the module singletons', () => {
    const fresh = new SessionHandle();
    try {
      expect(fresh.interrupts).not.toBe(interruptRegistry);
      expect(fresh.executions).not.toBe(executionRegistry);
      expect(fresh.coordinators).not.toBe(runCoordinatorBridge);
      expect(fresh.subscriptions).not.toBe(executionSubscriptionBinder);
      expect(fresh.status).not.toBe(StreamStatusService);
      expect(fresh.events).not.toBe(defaultSession().events);
      expect(fresh.transcripts).not.toBe(defaultSession().transcripts);
      expect(fresh.followUps).not.toBe(defaultSession().followUps);
      expect(fresh.flushers).not.toBe(getActiveFlushers());
      expect(fresh.hostChannel).toBeUndefined();
    } finally {
      fresh.dispose();
    }
  });

  it('builds fresh registries even when only a host channel is injected', () => {
    const { host } = createRecordingHost();
    const session = new SessionHandle({ hostChannel: host });
    try {
      expect(session.hostChannel).toBe(host);
      expect(session.executions).not.toBe(executionRegistry);
      expect(session.interrupts).not.toBe(interruptRegistry);
    } finally {
      session.dispose();
    }
  });

  it('keeps execution tracking isolated between sessions', () => {
    const a = new SessionHandle();
    const b = new SessionHandle();
    const { host } = createRecordingHost();
    try {
      const handle = trackAgent(
        a,
        host,
        createCoordinators(host),
        'exec:isolated',
        'stream:isolated' as StreamTabId,
      );
      expect(a.executions.getHandle('exec:isolated')).toBe(handle);
      expect(b.executions.getHandle('exec:isolated')).toBeUndefined();

      // Disposing A leaves B's separate registry untouched.
      const handleB = trackAgent(
        b,
        host,
        createCoordinators(host),
        'exec:b',
        'stream:b' as StreamTabId,
      );
      a.dispose();
      expect(a.executions.getHandle('exec:isolated')).toBeUndefined();
      expect(b.executions.getHandle('exec:b')).toBe(handleB);
    } finally {
      b.dispose();
    }
  });

  it("cleanupAllRequests on one session leaves the other's pending requests", async () => {
    const a = new SessionHandle();
    const b = new SessionHandle();
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const coordA = createCoordinators(hostA.host);
    const coordB = createCoordinators(hostB.host);
    const streamId = 'stream:cleanup-scope' as StreamTabId;
    const contextA = createRunContext({
      runtimeHost: hostA.host,
      coordinators: coordA,
    });
    const contextB = createRunContext({
      runtimeHost: hostB.host,
      coordinators: coordB,
    });

    try {
      const planA = withRunContext(contextA, () =>
        a.coordinators.waitForPlanApproval(streamId, {
          approvalId: 'approval:a',
          plan,
        }),
      );
      const retryA = withRunContext(contextA, () =>
        a.coordinators.waitForRetry(streamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );
      const planB = withRunContext(contextB, () =>
        b.coordinators.waitForPlanApproval(streamId, {
          approvalId: 'approval:b',
          plan,
        }),
      );
      const retryB = withRunContext(contextB, () =>
        b.coordinators.waitForRetry(streamId, {
          operation: 'Model invocation',
          logger: createLogger(),
        }),
      );

      a.coordinators.cleanupAllRequests();

      // A's pending requests resolve to their cancelled defaults...
      await expect(planA).resolves.toEqual({ action: 'reject' });
      await expect(retryA).resolves.toEqual({ action: 'cancel' });

      // ...while B's remain live and resolvable through B's own bridge.
      expect(
        hostB.host.interactions?.resolve('approval:b', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      expect(b.coordinators.triggerRetry(streamId, 'retry B')).toBe(true);
      await expect(planB).resolves.toEqual({ action: 'approve' });
      await expect(retryB).resolves.toEqual({
        action: 'retry',
        feedback: 'retry B',
      });
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('dispose tears down each owned member', () => {
    const session = new SessionHandle();
    const cleanup = vi.spyOn(session.coordinators, 'cleanupAllRequests');
    const subscriptions = vi.spyOn(session.subscriptions, 'dispose');
    const executions = vi.spyOn(session.executions, 'dispose');
    const retainOnly = vi.spyOn(session.interrupts, 'retainOnly');

    session.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveBeenCalledOnce();
    expect(executions).toHaveBeenCalledOnce();
    expect(retainOnly).toHaveBeenCalledWith(new Set());
  });

  it('can keep active executions visible until they settle', async () => {
    const session = new SessionHandle();
    const { host } = createRecordingHost();
    const executionId = 'exec:dispose-keep-active';
    const streamId = 'stream:dispose-keep-active' as StreamTabId;
    const cleanup = vi.spyOn(session.coordinators, 'cleanupAllRequests');
    const subscriptions = vi.spyOn(session.subscriptions, 'dispose');
    try {
      const handle = trackAgent(
        session,
        host,
        createCoordinators(host),
        executionId,
        streamId,
      );

      session.dispose({ keepActiveExecutions: true });

      expect(session.executions.getHandle(executionId)).toBe(handle);
      expect(getAllActiveExecutionIds()).toContain(executionId);
      expect(cleanup).not.toHaveBeenCalled();
      expect(subscriptions).not.toHaveBeenCalled();

      session.executions.untrack(executionId);

      await vi.waitFor(() => {
        expect(getAllActiveExecutionIds()).not.toContain(executionId);
      });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(subscriptions).toHaveBeenCalledOnce();
    } finally {
      session.executions.untrack(executionId);
      session.dispose();
    }
  });

  it('makes deferred dispose idempotent while executions are active', async () => {
    const session = new SessionHandle();
    const { host } = createRecordingHost();
    const executionId = 'exec:dispose-idempotent';
    const streamId = 'stream:dispose-idempotent' as StreamTabId;
    const executionsDispose = vi.spyOn(session.executions, 'dispose');
    try {
      const handle = trackAgent(
        session,
        host,
        createCoordinators(host),
        executionId,
        streamId,
      );

      session.dispose({ keepActiveExecutions: true });
      session.dispose();

      expect(session.executions.getHandle(executionId)).toBe(handle);
      expect(executionsDispose).not.toHaveBeenCalled();

      session.executions.untrack(executionId);

      await vi.waitFor(() => {
        expect(session.executions.getHandle(executionId)).toBeUndefined();
      });
      expect(executionsDispose).toHaveBeenCalledOnce();
    } finally {
      session.executions.untrack(executionId);
      session.dispose();
    }
  });
});
