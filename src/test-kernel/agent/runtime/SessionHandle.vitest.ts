import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit, SubscriptionRef } from 'effect';
import { describe, expect, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { type RunId } from '@shared/schemas';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
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
        const a = yield* Effect.acquireRelease(
          Effect.sync(() => createTestSession()),
          (session) => session.dispose(),
        );
        const b = yield* Effect.acquireRelease(
          Effect.sync(() => createTestSession()),
          (session) => session.dispose(),
        );
        const isolated = generateRunId();
        const runB = generateRunId();
        const provisional = generateRunId();
        trackAgent(a, provisional);
        const handle = trackAgent(a, isolated);
        expect(a.runs.getHandle(isolated)).toBe(handle);
        expect(b.runs.getHandle(isolated)).toBeUndefined();

        // Disposing A leaves B's separate registry untouched.
        const handleB = trackAgent(b, runB);
        // The project view can contain runs owned by another terminal.
        publishTestRunStart(a, isolated);
        publishTestRunStart(a, runB);
        yield* a.settlePublications();
        const foreignPolicy = SubscriptionRef.getUnsafe(a.view).policy.get(
          runB,
        );
        a.setApprovalPolicy('yolo');
        yield* a.settlePublications();
        expect(
          SubscriptionRef.getUnsafe(a.view).policy.get(isolated)?.policy,
        ).toBe('yolo');
        expect(SubscriptionRef.getUnsafe(a.view).policy.get(runB)).toEqual(
          foreignPolicy,
        );
        expect(b.approvalPolicy).toBe('ask');
        expect(SubscriptionRef.getUnsafe(a.view).runs.has(provisional)).toBe(
          false,
        );
        yield* a.settlePublications(provisional);
        // A birth queued before the next policy change must receive that
        // change even though the display has not folded the birth yet.
        publishTestRunStart(a, provisional);
        a.setApprovalPolicy('never');
        yield* a.settlePublications();
        expect(
          SubscriptionRef.getUnsafe(a.view).policy.get(provisional)?.policy,
        ).toBe('never');
        expect(SubscriptionRef.getUnsafe(a.view).policy.get(runB)).toEqual(
          foreignPolicy,
        );
        yield* a.dispose();
        expect(a.runs.getHandle(isolated)).toBeUndefined();
        expect(b.runs.getHandle(runB)).toBe(handleB);
      }),
  );

  it.effect('finishes owner teardown before surfacing a disposal failure', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      const failure = new Error('interaction disposal failed');
      const interactions = vi
        .spyOn(session.interactions, 'dispose')
        .mockImplementation(() => {
          throw failure;
        });
      const runs = vi.spyOn(session.runs, 'dispose');
      const exit = yield* Effect.exit(session.dispose());
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
      const session = createTestSession();
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
      yield* session.dispose();
      expect(attempted).toBe(true);
    }),
  );

  it.effect('rejects run work registered after disposal', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      yield* session.dispose();

      expect(() => trackAgent(session, generateRunId())).toThrow(
        'Cannot register run work after session disposal.',
      );
    }),
  );
});
