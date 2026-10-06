import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { describe, expect, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { type RunId } from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

function trackAgent(session: SessionHandle, runId: RunId): RunHandle {
  const handle = testRunHandle({
    runId,
    agent: 'orchestrator',
  });
  session.runs.track(handle);
  return handle;
}

describe('SessionHandle', () => {
  it.effect(
    'keeps run tracking and approval policy isolated between sessions',
    () =>
      Effect.gen(function* () {
        const a = yield* Effect.acquireRelease(createTestSession(), (session) =>
          closeSessionOf(session),
        );
        const b = yield* Effect.acquireRelease(createTestSession(), (session) =>
          closeSessionOf(session),
        );
        const isolated = generateRunId();
        const runB = generateRunId();
        const handle = trackAgent(a, isolated);
        expect(a.runs.getHandle(isolated)).toBe(handle);
        expect(b.runs.getHandle(isolated)).toBeUndefined();

        // Disposing A leaves B's separate registry untouched.
        const handleB = trackAgent(b, runB);
        // The policy is the session's own setting: a change on A writes no
        // row and leaves B's as it was.
        a.setApprovalPolicy('yolo');
        expect(a.approvalPolicy).toBe('yolo');
        expect(b.approvalPolicy).toBe('ask');
        yield* closeSessionOf(a);
        expect(a.runs.getHandle(isolated)).toBeUndefined();
        expect(b.runs.getHandle(runB)).toBe(handleB);
      }),
  );

  it.effect('finishes owner teardown before surfacing a disposal failure', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      const failure = new Error('interaction disposal failed');
      const interactions = vi
        .spyOn(session.interactions, 'dispose')
        .mockImplementation(() => {
          throw failure;
        });
      const runs = vi.spyOn(session.runs, 'dispose');
      const exit = yield* Effect.exit(closeSessionOf(session));
      expect(Exit.isFailure(exit)).toBe(true);
      // The teardown failure reaches the caller as a defect, not a typed fail.
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(
          failure,
        );
      expect(interactions).toHaveBeenCalledOnce();
      expect(runs).toHaveBeenCalled();
    }),
  );

  it.effect('refuses run work once disposal has begun', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      let attempted = false;
      // The handle's owners unwind after the session's runs: a launch reaching
      // the registry from inside that unwind is already refused.
      vi.spyOn(session.interactions, 'dispose').mockImplementation(() =>
        Effect.sync(() => {
          attempted = true;
          expect(() => trackAgent(session, generateRunId())).toThrow(
            'Cannot register run work after session disposal.',
          );
        }),
      );
      yield* closeSessionOf(session);
      expect(attempted).toBe(true);
    }),
  );
});
