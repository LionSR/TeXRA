// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { getActiveFlushers } from '@transcript';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  SessionHandle,
  defaultSession,
  getAllActiveExecutionIds,
} from '@agent/runtime/SessionHandle';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { type Plan, type StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const plan: Plan = { objective: 'Compose the per-session runtime owners.' };

function trackAgent(
  session: SessionHandle,
  host: AgentRuntimeHost,
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
  );
  session.executions.track(handle);
  return handle;
}

describe('SessionHandle', () => {
  it('defaultSession is a stable process-wide singleton (#7694: no separate module export to alias)', () => {
    // No `Shared*`/`*Service` module export exists anymore — the process
    // default's owners are installed together by the test composition root.
    // What's left to verify is that repeated calls return the identical
    // session (and therefore identical members), and that the flushers
    // member still aliases the process-wide flush registry by identity
    // (that accessor is intentionally NOT one of the deleted aliases — see
    // `runTrace.ts`'s `getActiveFlushers`).
    const first = defaultSession();
    const second = defaultSession();
    expect(second).toBe(first);
    expect(second.executions).toBe(first.executions);
    expect(second.subscriptions).toBe(first.subscriptions);
    expect(second.status).toBe(first.status);
    expect(second.events).toBe(first.events);
    expect(second.transcripts).toBe(first.transcripts);
    expect(second.followUps).toBe(first.followUps);
    expect(defaultSession().flushers).toBe(getActiveFlushers());
    expect(defaultSession().hostChannel).toBeUndefined();
  });

  it('a fresh session shares no member with the default session', () => {
    const fresh = createTestSession();
    try {
      expect(fresh.executions).not.toBe(defaultSession().executions);
      expect(fresh.subscriptions).not.toBe(defaultSession().subscriptions);
      expect(fresh.interactions).not.toBe(defaultSession().interactions);
      expect(fresh.status).not.toBe(defaultSession().status);
      expect(fresh.events).not.toBe(defaultSession().events);
      expect(fresh.transcripts).not.toBe(defaultSession().transcripts);
      expect(fresh.followUps).not.toBe(defaultSession().followUps);
      expect(fresh.approvals).not.toBe(defaultSession().approvals);
      expect(fresh.flushers).not.toBe(getActiveFlushers());
      expect(fresh.hostChannel).toBeUndefined();
    } finally {
      fresh.dispose();
    }
  });

  it('builds fresh registries even when only a host channel is injected', () => {
    const { host } = createRecordingHost();
    const session = createTestSession({ hostChannel: host });
    try {
      expect(session.hostChannel).toBe(host);
      expect(session.executions).not.toBe(defaultSession().executions);
    } finally {
      session.dispose();
    }
  });

  it('keeps execution tracking isolated between sessions', () => {
    const a = createTestSession();
    const b = createTestSession();
    const { host } = createRecordingHost();
    try {
      const handle = trackAgent(
        a,
        host,
        'exec:isolated',
        'stream:isolated' as StreamTabId,
      );
      expect(a.executions.getHandle('exec:isolated')).toBe(handle);
      expect(b.executions.getHandle('exec:isolated')).toBeUndefined();

      // Disposing A leaves B's separate registry untouched.
      const handleB = trackAgent(b, host, 'exec:b', 'stream:b' as StreamTabId);
      a.dispose();
      expect(a.executions.getHandle('exec:isolated')).toBeUndefined();
      expect(b.executions.getHandle('exec:b')).toBe(handleB);
    } finally {
      b.dispose();
    }
  });

  it("an unfiltered cancel on one session leaves the other's pending requests", async () => {
    const a = createTestSession();
    const b = createTestSession();
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const streamId = 'stream:cleanup-scope' as StreamTabId;
    a.useHostInteractions(hostA.interactions);
    b.useHostInteractions(hostB.interactions);

    try {
      const planA = a.interactions.requestPlanApproval({
        approvalId: 'approval:a',
        streamId,
        plan,
        goalEnabled: false,
      });
      const retryA = a.interactions.requestRetry({
        streamId,
        operation: 'Model invocation',
      });
      const planB = b.interactions.requestPlanApproval({
        approvalId: 'approval:b',
        streamId,
        plan,
        goalEnabled: false,
      });
      const retryB = b.interactions.requestRetry({
        streamId,
        operation: 'Model invocation',
      });

      a.interactions.cancel({ cause: 'All approvals cleared.' });

      // A's pending requests resolve to their cancelled defaults...
      await expect(planA).resolves.toEqual({ action: 'reject' });
      await expect(retryA).resolves.toEqual({ action: 'cancel' });

      // ...while B's remain live and resolvable through B's own port.
      expect(
        b.interactions.resolve('approval:b', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      expect(
        b.interactions.resolve(streamId, {
          kind: 'retry',
          action: 'retry',
          feedback: 'retry B',
        }),
      ).toBe(true);
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
    const session = createTestSession();
    const interactions = vi.spyOn(session.interactions, 'dispose');
    const subscriptions = vi.spyOn(session.subscriptions, 'dispose');
    const executions = vi.spyOn(session.executions, 'dispose');

    session.dispose();

    expect(interactions).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveBeenCalledOnce();
    expect(executions).toHaveBeenCalledOnce();
  });

  it('can keep active executions visible until they settle', async () => {
    const session = createTestSession();
    const { host } = createRecordingHost();
    const executionId = 'exec:dispose-keep-active';
    const streamId = 'stream:dispose-keep-active' as StreamTabId;
    const cleanup = vi.spyOn(session.interactions, 'dispose');
    const subscriptions = vi.spyOn(session.subscriptions, 'dispose');
    try {
      const handle = trackAgent(session, host, executionId, streamId);

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
    const session = createTestSession();
    const { host } = createRecordingHost();
    const executionId = 'exec:dispose-idempotent';
    const streamId = 'stream:dispose-idempotent' as StreamTabId;
    const executionsDispose = vi.spyOn(session.executions, 'dispose');
    try {
      const handle = trackAgent(session, host, executionId, streamId);

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
