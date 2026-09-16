import { it } from '@effect/vitest';
import { Deferred, Effect, Stream } from 'effect';
import { describe, expect } from 'vitest';

import { type SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  RunIdSchema,
} from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
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
  type GoalStateChange,
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
function collectGoalChanges(session: SessionHandle) {
  return Effect.gen(function* () {
    const seen: GoalStateChange[] = [];
    const delivered = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      Stream.runForEach(goalStateChanges(session), (change) =>
        Effect.gen(function* () {
          seen.push(change);
          yield* Deferred.succeed(delivered, undefined);
        }),
      ),
    );
    return { seen, first: Deferred.await(delivered) };
  });
}

describe('the goal row is the goal', () => {
  setupPlatform();

  it.effect('reads back per run and across runs, and clearing drops one', () =>
    Effect.gen(function* () {
      const session = createTestSession({ roots: paperRoots('read-back') });
      yield* Effect.addFinalizer(() => session.dispose());
      publishTestRunStart(session, RUN_A);
      publishTestRunStart(session, RUN_B);
      yield* startGoal(session, RUN_A, 'objective a');
      yield* startGoal(session, RUN_B, 'objective b');
      expect(
        goalList(session)
          .map((goal) => goal.runId)
          .toSorted(),
      ).toEqual([RUN_A, RUN_B].toSorted());

      yield* clearGoal(session, RUN_A);

      expect(goalOf(session, RUN_A)).toBeNull();
      expect(goalList(session).map((goal) => goal.runId)).toEqual([RUN_B]);
    }),
  );

  it.effect(
    'lets the same run start a fresh goal after the last one is cleared',
    () =>
      Effect.gen(function* () {
        const session = createTestSession({ roots: paperRoots('restart') });
        yield* Effect.addFinalizer(() => session.dispose());
        publishTestRunStart(session, RUN_A);
        const first = yield* startGoal(session, RUN_A, 'objective one');
        yield* clearGoal(session, RUN_A);

        const next = yield* startGoal(session, RUN_A, 'objective two');
        expect(next.goalId).not.toBe(first.goalId);
        expect(goalOf(session, RUN_A)).toMatchObject({
          objective: 'objective two',
          status: 'active',
        });
      }),
  );

  it.effect(
    'parks a pursuit on pause and resumes the same one on retarget',
    () =>
      Effect.gen(function* () {
        const session = createTestSession({ roots: paperRoots('lifecycle') });
        yield* Effect.addFinalizer(() => session.dispose());
        publishTestRunStart(session, RUN_A);
        const started = yield* startGoal(session, RUN_A, 'prove the estimate');

        yield* pauseGoal(session, RUN_A);
        expect(goalOf(session, RUN_A)?.status).toBe('paused');

        yield* retargetGoal(session, RUN_A, 'prove the sharp estimate');
        expect(goalOf(session, RUN_A)).toEqual({
          ...started,
          objective: 'prove the sharp estimate',
          status: 'active',
        });
      }),
  );

  it.effect('refuses a second goal while one is in flight', () =>
    Effect.gen(function* () {
      const session = createTestSession({ roots: paperRoots('in-flight') });
      yield* Effect.addFinalizer(() => session.dispose());
      publishTestRunStart(session, RUN_A);
      yield* startGoal(session, RUN_A, 'objective one');
      const error = yield* Effect.flip(
        startGoal(session, RUN_A, 'objective two'),
      );
      expect(error.message).toContain(
        'A goal is already in progress for this run',
      );
    }),
  );

  it.effect('drops the goal with the run it belongs to', () =>
    Effect.gen(function* () {
      const session = createTestSession({ roots: paperRoots('removal') });
      yield* Effect.addFinalizer(() => session.dispose());
      publishTestRunStart(session, RUN_A);
      yield* startGoal(session, RUN_A, 'objective a');

      session.publish([
        {
          type: 'run.removed',
          aggregateId: qualifyAggregateId('run', RUN_A),
        },
      ]);
      yield* session.settlePublications();

      expect(goalOf(session, RUN_A)).toBeNull();
      expect(goalList(session)).toEqual([]);
    }),
  );
});

describe('goalStateChanges', () => {
  setupPlatform();

  it.effect('delivers only goal changes from the supplied session', () =>
    Effect.gen(function* () {
      // Two papers: a session's plane is its workspace root's.
      const sessionA = createTestSession({ roots: paperRoots('a') });
      yield* Effect.addFinalizer(() => sessionA.dispose());
      const sessionB = createTestSession({ roots: paperRoots('b') });
      yield* Effect.addFinalizer(() => sessionB.dispose());
      publishTestRunStart(sessionA, SAME_SESSION_RUN);
      publishTestRunStart(sessionB, OTHER_SESSION_RUN);
      const changes = yield* collectGoalChanges(sessionA);

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
      yield* sessionA.settlePublications();
      yield* sessionB.settlePublications();
      yield* changes.first;

      expect(changes.seen).toEqual([{ runId: SAME_SESSION_RUN }]);
    }),
  );

  it.effect('notifies the mutated session alone, once per mutation', () =>
    Effect.gen(function* () {
      const runSession = createTestSession({ roots: paperRoots('run') });
      yield* Effect.addFinalizer(() => runSession.dispose());
      const otherSession = createTestSession({ roots: paperRoots('other') });
      yield* Effect.addFinalizer(() => otherSession.dispose());
      publishTestRunStart(runSession, SUBSCRIPTION_RUN);
      const run = yield* collectGoalChanges(runSession);
      const other = yield* collectGoalChanges(otherSession);
      const fallback = yield* collectGoalChanges(testDefaultSession());

      yield* startGoal(runSession, SUBSCRIPTION_RUN, 'prove the estimate');
      yield* pauseGoal(runSession, SUBSCRIPTION_RUN);
      yield* retargetGoal(
        runSession,
        SUBSCRIPTION_RUN,
        'prove the sharp estimate',
      );
      yield* run.first;

      expect(run.seen).toEqual([
        { runId: SUBSCRIPTION_RUN },
        { runId: SUBSCRIPTION_RUN },
        { runId: SUBSCRIPTION_RUN },
      ]);
      expect(other.seen).toEqual([]);
      expect(fallback.seen).toEqual([]);
    }),
  );
});
