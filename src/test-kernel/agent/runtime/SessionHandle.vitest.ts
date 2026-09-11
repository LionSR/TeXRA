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
