import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import {
  SessionHandle,
  defaultSession,
  forEachLiveSession,
} from '@agent/runtime/SessionHandle';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { type Plan, type StreamTabId } from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createRecordingHost } from '../progressTestUtils';

const plan: Plan = { objective: 'Compose the per-session runtime owners.' };

function trackAgent(
  session: SessionHandle,
  executionId: string,
  streamId: StreamTabId,
): AgentExecutionHandle {
  const handle = testExecutionHandle({
    executionId,
    parentStreamId: streamId,
    agent: 'orchestrator',
  });
  session.executions.track(handle);
  return handle;
}

describe('SessionHandle', () => {
  it('awaits artifact writers before disposal and leaves the live-session registry', async () => {
    const session = createTestSession();
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    session.useArtifactFlusher(() => writerGate);
    const dispose = vi.spyOn(session, 'dispose');
    const killBackgroundProcesses = vi
      .spyOn(session.executions, 'killBackgroundProcesses')
      .mockImplementation(() => undefined);

    const shutdown = (async () => {
      await session.flushArtifacts();
      session.dispose();
    })();

    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    forEachLiveSession((live) => {
      live.executions.killBackgroundProcesses();
    });
    expect(killBackgroundProcesses).toHaveBeenCalledOnce();

    releaseWriter();
    await shutdown;
    expect(dispose).toHaveBeenCalledOnce();

    forEachLiveSession((live) => {
      live.executions.killBackgroundProcesses();
    });
    expect(killBackgroundProcesses).toHaveBeenCalledOnce();
  });

  it('waits for every artifact writer and reports all failures', async () => {
    const session = createTestSession();
    const firstError = new Error('first artifact failed');
    const snapshotError = new Error('snapshot failed');
    const laterWriter = vi.fn();
    session.useArtifactFlusher(async () => {
      throw firstError;
    });
    session.useArtifactFlusher(() => {
      throw snapshotError;
    });
    session.useArtifactFlusher(async () => laterWriter());

    try {
      const failure = await session.flushArtifacts().catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        firstError,
        snapshotError,
      ]);
      expect(laterWriter).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it('coalesces durability calls made in the same synchronous burst', async () => {
    const session = createTestSession();
    const flush = vi.fn(async () => {});
    session.useArtifactFlusher(flush);
    try {
      const first = session.flushArtifacts();
      const second = session.flushArtifacts();

      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it('runs one trailing durability batch for calls arriving mid-flush', async () => {
    const session = createTestSession();
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const flush = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValue(undefined);
    session.useArtifactFlusher(flush);
    try {
      const first = session.flushArtifacts();
      await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
      const trailing = session.flushArtifacts();

      expect(trailing).not.toBe(first);
      releaseFirst();
      await Promise.all([first, trailing]);
      expect(flush).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });

  it('defaultSession is a stable process-wide singleton', () => {
    const first = defaultSession();
    const second = defaultSession();
    expect(second).toBe(first);
    expect(second.executions).toBe(first.executions);
    expect(second.status).toBe(first.status);
    expect(second.events).toBe(first.events);
    expect(second.transcripts).toBe(first.transcripts);
    expect(second.followUps).toBe(first.followUps);
  });

  it('a fresh session shares no member with the default session', () => {
    const fresh = createTestSession();
    const fallback = defaultSession();
    try {
      expect(fresh.executions).not.toBe(fallback.executions);
      expect(fresh.interactions).not.toBe(fallback.interactions);
      expect(fresh.status).not.toBe(fallback.status);
      // `events` is the root's plane (`Sessions`, keyed by workspace root),
      // shared by every session on one root by design.
      expect(fresh.transcripts).not.toBe(fallback.transcripts);
      expect(fresh.snapshots).not.toBe(fallback.snapshots);
      expect(fresh.followUps).not.toBe(fallback.followUps);
      expect(fresh.approvals).not.toBe(fallback.approvals);
      expect(fresh.modelRetries).not.toBe(fallback.modelRetries);
      expect(fresh.responseTextProcessing).not.toBe(
        fallback.responseTextProcessing,
      );
      expect(fresh.workflowControls).not.toBe(fallback.workflowControls);
      fresh.setApprovalPolicy('yolo');
      expect(fresh.approvalPolicy).toBe('yolo');
      expect(fallback.approvalPolicy).toBe('ask');
    } finally {
      fresh.dispose();
    }
  });

  it('keeps execution tracking isolated between sessions', () => {
    const a = createTestSession();
    const b = createTestSession();
    try {
      const handle = trackAgent(
        a,
        'exec:isolated',
        'stream:isolated' as StreamTabId,
      );
      expect(a.executions.getHandle('exec:isolated')).toBe(handle);
      expect(b.executions.getHandle('exec:isolated')).toBeUndefined();

      // Disposing A leaves B's separate registry untouched.
      const handleB = trackAgent(b, 'exec:b', 'stream:b' as StreamTabId);
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
    a.interactions.use(hostA.interactions);
    b.interactions.use(hostB.interactions);

    try {
      const planA = a.interactions.requestPlanApproval({
        requestId: 'approval:a',
        streamId,
        plan,
        goalEnabled: false,
      });
      const retryA = a.interactions.requestRetry({
        requestId: 'retry:a',
        streamId,
        operation: 'Model invocation',
      });
      const planB = b.interactions.requestPlanApproval({
        requestId: 'approval:b',
        streamId,
        plan,
        goalEnabled: false,
      });
      const retryB = b.interactions.requestRetry({
        requestId: 'retry:b',
        streamId,
        operation: 'Model invocation',
      });

      a.interactions.cancel({ cause: 'All approvals cleared.' });

      // A's pending requests resolve to their cancelled defaults...
      await expect(planA).resolves.toEqual({ action: 'reject' });
      await expect(retryA).resolves.toEqual({ action: 'cancel' });

      // ...while B's remain live and resolvable through B's own port.
      expect(
        hostB.decisions.submitPlan('approval:b', { action: 'approve' }),
      ).toBe(true);
      expect(
        hostB.decisions.submitRetry(streamId, {
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
    const executions = vi.spyOn(session.executions, 'dispose');

    session.dispose();

    expect(interactions).toHaveBeenCalledOnce();
    expect(executions).toHaveBeenCalledOnce();
  });

  it('finishes owner teardown before surfacing a disposal failure', () => {
    const session = createTestSession();
    const failure = new Error('interaction disposal failed');
    const interactions = vi
      .spyOn(session.interactions, 'dispose')
      .mockImplementation(() => {
        throw failure;
      });
    const executions = vi.spyOn(session.executions, 'dispose');
    expect(() => session.dispose()).toThrow(failure);
    expect(interactions).toHaveBeenCalledOnce();
    expect(executions).toHaveBeenCalledOnce();
  });

  it('rejects execution work registered after disposal', () => {
    const session = createTestSession();
    session.dispose();

    expect(() =>
      trackAgent(session, 'exec:late', 'stream:late' as StreamTabId),
    ).toThrow('Cannot register execution work after session disposal.');
  });
});
