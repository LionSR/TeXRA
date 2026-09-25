import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

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
  goalOf,
  pauseGoal,
  retargetGoal,
  startGoal,
} from '@tools/goal';

const RUN_A = RunIdSchema.parse('fa0000000a0a');
const RUN_B = RunIdSchema.parse('fa0000000b0b');

/** The roots of one paper: a session's plane is keyed by its storage root. */
function paperRoots(name: string) {
  return createFakeWorkspaceRoots({
    storagePath: `/workspace/${name}/.texra/storage`,
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
      expect(goalOf(session, RUN_A)?.objective).toBe('objective a');
      expect(goalOf(session, RUN_B)?.objective).toBe('objective b');

      yield* clearGoal(session, RUN_A);

      expect(goalOf(session, RUN_A)).toBeNull();
      expect(goalOf(session, RUN_B)?.objective).toBe('objective b');
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
    }),
  );
});
