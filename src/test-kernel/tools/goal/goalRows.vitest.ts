import '@test/support/defaultSessionTestSetup';

import { Effect, Fiber, Stream } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { effectRuntime } from '@platform/processRuntime';
import {
  aggregateId as qualifyAggregateId,
  RunIdSchema,
} from '@shared/schemas';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  clearGoal,
  goalList,
  goalOf,
  goalStateChanges,
  pauseGoal,
  retargetGoal,
  startGoal,
} from '@tools/goal';

const RUN_A = RunIdSchema.parse('fa0000000a0a');
const RUN_B = RunIdSchema.parse('fa0000000b0b');
const SUBSCRIPTION_RUN = RunIdSchema.parse('5b5c00000001');
const SAME_SESSION_RUN = RunIdSchema.parse('5a3e00000001');
const OTHER_SESSION_RUN = RunIdSchema.parse('01e300000001');

/** The roots of one paper: a session's plane is keyed by its storage root. */
function paperRoots(name: string) {
  return createFakeWorkspaceRoots({
    storagePath: `/workspace/${name}/.texra/storage`,
  });
}

/** Records every goal-state change delivered to one session. */
function collectGoalChanges(session: SessionHandle): {
  seen: unknown[];
  clear: () => void;
  detach: () => void;
} {
  const seen: unknown[] = [];
  const fiber = effectRuntime().runFork(
    Stream.runForEach(goalStateChanges(session), (change) =>
      Effect.sync(() => {
        seen.push(change);
      }),
    ),
  );
  return {
    seen,
    clear: () => {
      seen.length = 0;
    },
    detach: () => {
      effectRuntime().runFork(Fiber.interrupt(fiber));
    },
  };
}

describe('the goal row is the goal', () => {
  setupPlatform();

  it('reads back per run and across runs, and clearing drops one', async () => {
    const session = createTestSession({ roots: paperRoots('read-back') });
    publishTestRunStart(session, RUN_A);
    publishTestRunStart(session, RUN_B);
    try {
      startGoal(session, RUN_A, 'objective a');
      startGoal(session, RUN_B, 'objective b');
      await session.settlePublications();
      expect(
        goalList(session)
          .map((goal) => goal.runId)
          .toSorted(),
      ).toEqual([RUN_A, RUN_B].toSorted());

      clearGoal(session, RUN_A);
      await session.settlePublications();

      expect(goalOf(session, RUN_A)).toBeNull();
      expect(goalList(session).map((goal) => goal.runId)).toEqual([RUN_B]);
    } finally {
      session.dispose();
    }
  });

  it('lets the same run start a fresh goal after the last one is cleared', async () => {
    const session = createTestSession({ roots: paperRoots('restart') });
    publishTestRunStart(session, RUN_A);
    try {
      const first = startGoal(session, RUN_A, 'objective one');
      await session.settlePublications();
      clearGoal(session, RUN_A);
      await session.settlePublications();

      const next = startGoal(session, RUN_A, 'objective two');
      await session.settlePublications();
      expect(next.goalId).not.toBe(first.goalId);
      expect(goalOf(session, RUN_A)).toMatchObject({
        objective: 'objective two',
        status: 'active',
      });
    } finally {
      session.dispose();
    }
  });

  it('parks a pursuit on pause and resumes the same one on retarget', async () => {
    const session = createTestSession({ roots: paperRoots('lifecycle') });
    publishTestRunStart(session, RUN_A);
    try {
      const started = startGoal(session, RUN_A, 'prove the estimate');
      await session.settlePublications();

      pauseGoal(session, RUN_A);
      await session.settlePublications();
      expect(goalOf(session, RUN_A)?.status).toBe('paused');

      retargetGoal(session, RUN_A, 'prove the sharp estimate');
      await session.settlePublications();
      expect(goalOf(session, RUN_A)).toEqual({
        ...started,
        objective: 'prove the sharp estimate',
        status: 'active',
      });
    } finally {
      session.dispose();
    }
  });

  it('refuses a second goal while one is in flight', async () => {
    const session = createTestSession({ roots: paperRoots('in-flight') });
    publishTestRunStart(session, RUN_A);
    try {
      startGoal(session, RUN_A, 'objective one');
      await session.settlePublications();
      expect(() => startGoal(session, RUN_A, 'objective two')).toThrow(
        'A goal is already in progress for this run',
      );
    } finally {
      session.dispose();
    }
  });

  it('drops the goal with the run it belongs to', async () => {
    const session = createTestSession({ roots: paperRoots('removal') });
    publishTestRunStart(session, RUN_A);
    try {
      startGoal(session, RUN_A, 'objective a');
      await session.settlePublications();

      session.publish([
        {
          type: 'run.removed',
          aggregateId: qualifyAggregateId('run', RUN_A),
        },
      ]);
      await session.settlePublications();

      expect(goalOf(session, RUN_A)).toBeNull();
      expect(goalList(session)).toEqual([]);
    } finally {
      session.dispose();
    }
  });
});

describe('goalStateChanges', () => {
  setupPlatform();

  it('delivers only goal changes from the supplied session', async () => {
    // Two papers: a session's plane is its workspace root's.
    const sessionA = createTestSession({ roots: paperRoots('a') });
    const sessionB = createTestSession({ roots: paperRoots('b') });
    publishTestRunStart(sessionA, SAME_SESSION_RUN);
    publishTestRunStart(sessionB, OTHER_SESSION_RUN);
    const { seen, detach } = collectGoalChanges(sessionA);

    try {
      sessionB.publish([
        {
          type: 'goalStateChanged',
          aggregateId: qualifyAggregateId('run', OTHER_SESSION_RUN),
          state: { active: false },
        },
      ]);
      sessionA.publish([
        {
          type: 'run.description',
          aggregateId: qualifyAggregateId('run', SAME_SESSION_RUN),
          description: 'not a goal change',
        },
      ]);
      sessionA.publish([
        {
          type: 'goalStateChanged',
          aggregateId: qualifyAggregateId('run', SAME_SESSION_RUN),
          state: { active: false },
        },
      ]);
      await Promise.all([
        sessionA.settlePublications(),
        sessionB.settlePublications(),
      ]);

      expect(seen).toEqual([{ runId: SAME_SESSION_RUN }]);
    } finally {
      detach();
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('notifies the mutated session alone, once per mutation', async () => {
    const runSession = createTestSession({ roots: paperRoots('run') });
    const otherSession = createTestSession({ roots: paperRoots('other') });
    publishTestRunStart(runSession, SUBSCRIPTION_RUN);
    const run = collectGoalChanges(runSession);
    const other = collectGoalChanges(otherSession);
    const fallback = collectGoalChanges(defaultSession());

    try {
      startGoal(runSession, SUBSCRIPTION_RUN, 'prove the estimate');
      await runSession.settlePublications();
      pauseGoal(runSession, SUBSCRIPTION_RUN);
      await runSession.settlePublications();
      retargetGoal(runSession, SUBSCRIPTION_RUN, 'prove the sharp estimate');
      await runSession.settlePublications();

      expect(run.seen).toEqual([
        { runId: SUBSCRIPTION_RUN },
        { runId: SUBSCRIPTION_RUN },
        { runId: SUBSCRIPTION_RUN },
      ]);
      expect(other.seen).toEqual([]);
      expect(fallback.seen).toEqual([]);
    } finally {
      run.detach();
      other.detach();
      fallback.detach();
      runSession.dispose();
      otherSession.dispose();
    }
  });
});
