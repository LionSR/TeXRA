import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';
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
  it('keeps run tracking isolated between sessions', async () => {
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
      await Effect.runPromise(a.dispose());
      expect(a.runs.getHandle(isolated)).toBeUndefined();
      expect(b.runs.getHandle(runB)).toBe(handleB);
    } finally {
      await Effect.runPromise(b.dispose());
    }
  });

  it('finishes owner teardown before surfacing a disposal failure', async () => {
    const session = createTestSession();
    const failure = new Error('interaction disposal failed');
    const interactions = vi
      .spyOn(session.interactions, 'dispose')
      .mockImplementation(() => {
        throw failure;
      });
    const runs = vi.spyOn(session.runs, 'dispose');
    await expect(Effect.runPromise(session.dispose())).rejects.toThrow(failure);
    expect(interactions).toHaveBeenCalledOnce();
    expect(runs).toHaveBeenCalled();
  });

  it('refuses run work once disposal has begun', async () => {
    const session = createTestSession();
    let attempted = false;
    // The handle's owners unwind after the session's runs: a launch reaching
    // the registry from inside that unwind is already refused.
    vi.spyOn(session.interactions, 'dispose').mockImplementation(() => {
      attempted = true;
      expect(() => trackAgent(session, generateRunId())).toThrow(
        'Cannot register run work after session disposal.',
      );
    });
    await Effect.runPromise(session.dispose());
    expect(attempted).toBe(true);
  });

  it('rejects run work registered after disposal', async () => {
    const session = createTestSession();
    await Effect.runPromise(session.dispose());

    expect(() => trackAgent(session, generateRunId())).toThrow(
      'Cannot register run work after session disposal.',
    );
  });
});
