import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { goalOf, pauseGoal, startGoal } from '@tools/goal';
import { generateRunId } from '@utils/core';

const RUN_ID = generateRunId();

describe('maybeBuildGoalContinuation', () => {
  let session: SessionHandle;

  beforeEach(async () => {
    await installFakePlatform();
    session = createTestSession();
    publishTestRunStart(session, RUN_ID);
  });

  afterEach(async () => {
    await Effect.runPromise(session.dispose());
  });

  it.effect(
    'renders an objective containing nunjucks-significant syntax as literal text',
    () =>
      Effect.gen(function* () {
        // The objective is a context *value* substituted into the template, not
        // concatenated into the template source — nunjucks must not re-parse it
        // as template syntax (no injection, no `{{ 1 + 1 }}` evaluating to `2`).
        const objective =
          'Finish {% for x in y %}{{ 1 + 1 }}{# comment #}{% endfor %} the "quoted" \\task\\.';
        yield* startGoal(session, RUN_ID, objective);
        const out = yield* maybeBuildGoalContinuation(session, RUN_ID);
        expect(out).toContain(objective);
      }),
  );

  it.effect('returns null when the goal is paused', () =>
    Effect.gen(function* () {
      yield* startGoal(session, RUN_ID, 'objective');
      yield* pauseGoal(session, RUN_ID);

      expect(yield* maybeBuildGoalContinuation(session, RUN_ID)).toBeNull();
    }),
  );

  it.effect('is a pure read — leaves the goal untouched', () =>
    Effect.gen(function* () {
      const before = yield* startGoal(session, RUN_ID, 'objective');
      yield* maybeBuildGoalContinuation(session, RUN_ID);
      yield* session.settlePublications();
      // No counter, no audit log: the helper only reads. The loop runs until
      // the model completes or the user stops it.
      expect(goalOf(session, RUN_ID)).toEqual(before);
    }),
  );
});
