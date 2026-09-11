import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { SessionHandle, defaultSession } from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { type Plan, type RunId } from '@shared/schemas';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';
import { createRecordingHost } from '../progressTestUtils';

const plan: Plan = { objective: 'Compose the per-session runtime owners.' };

function trackAgent(session: SessionHandle, runId: RunId): RunHandle {
  const handle = testRunHandle({
    runId,
    agent: 'orchestrator',
  });
  session.runs.track(handle);
  return handle;
}

describe('SessionHandle', () => {
  it('defaultSession is a stable process-wide singleton', () => {
    const first = defaultSession();
    const second = defaultSession();
    expect(second).toBe(first);
    expect(second.runs).toBe(first.runs);
    expect(second.status).toBe(first.status);
    expect(second.events).toBe(first.events);
    expect(second.transcripts).toBe(first.transcripts);
    expect(second.followUps).toBe(first.followUps);
  });

  it('a fresh session shares no member with the default session', () => {
    const fresh = createTestSession();
    const fallback = defaultSession();
    try {
      expect(fresh.runs).not.toBe(fallback.runs);
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

  it('keeps run tracking isolated between sessions', () => {
    const a = createTestSession();
    const b = createTestSession();
    try {
      const isolated = generateRunId();
      const runB = generateRunId();
      const handle = trackAgent(a, isolated);
      expect(a.runs.getHandle(isolated)).toBe(handle);
      expect(b.runs.getHandle(isolated)).toBeUndefined();

      // Disposing A leaves B's separate registry untouched.
      const handleB = trackAgent(b, runB);
      a.dispose();
      expect(a.runs.getHandle(isolated)).toBeUndefined();
      expect(b.runs.getHandle(runB)).toBe(handleB);
    } finally {
      b.dispose();
    }
  });

  it("an unfiltered cancel on one session leaves the other's pending requests", async () => {
    const a = createTestSession();
    const b = createTestSession();
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const runId = generateRunId();
    a.interactions.use(hostA.interactions);
    b.interactions.use(hostB.interactions);

    try {
      const planA = a.interactions.requestPlanApproval({
        requestId: 'approval:a',
        runId,
        plan,
        goalEnabled: false,
      });
      const retryA = a.interactions.requestRetry({
        requestId: 'retry:a',
        runId,
        operation: 'Model invocation',
      });
      const planB = b.interactions.requestPlanApproval({
        requestId: 'approval:b',
        runId,
        plan,
        goalEnabled: false,
      });
      const retryB = b.interactions.requestRetry({
        requestId: 'retry:b',
        runId,
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
        hostB.decisions.submitRetry(runId, {
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
    const executions = vi.spyOn(session.runs, 'dispose');

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
    const runs = vi.spyOn(session.runs, 'dispose');
    expect(() => session.dispose()).toThrow(failure);
    expect(interactions).toHaveBeenCalledOnce();
    expect(runs).toHaveBeenCalledOnce();
  });

  it('rejects run work registered after disposal', () => {
    const session = createTestSession();
    session.dispose();

    expect(() => trackAgent(session, generateRunId())).toThrow(
      'Cannot register run work after session disposal.',
    );
  });
});
