import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { workspaceRoots } from '@platform/workspaceRoots';
import { GOAL_FEATURE_FLAG_KEY, type Goal } from '@shared/schemas';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { goalOf, isGoalEnabled, pauseGoal, startGoal } from '@tools/goal';
import { generateRunId } from '@utils/core';

const RUN_ID = generateRunId();

async function installPlatformWithConfig(
  config: Record<string, unknown>,
): Promise<void> {
  await installFakePlatform({ config });
}

describe('isGoalEnabled', () => {
  it.each([
    {
      name: 'defaults on when the key is not set',
      config: {},
      expected: true,
    },
    {
      name: 'honors an explicit false',
      config: { [GOAL_FEATURE_FLAG_KEY]: false },
      expected: false,
    },
    {
      name: 'honors an explicit true',
      config: { [GOAL_FEATURE_FLAG_KEY]: true },
      expected: true,
    },
  ])('$name', async ({ config, expected }) => {
    await installPlatformWithConfig(config);

    expect(isGoalEnabled()).toBe(expected);
  });
});

describe('maybeBuildGoalContinuation', () => {
  let session: SessionHandle;

  beforeEach(async () => {
    await installPlatformWithConfig({ [GOAL_FEATURE_FLAG_KEY]: true });
    session = createTestSession();
    publishTestRunStart(session, RUN_ID);
  });

  afterEach(() => {
    session.dispose();
  });

  /** Commit the goal row and let the fold land it before the read. */
  async function goalOnTheRun(objective: string): Promise<Goal> {
    const goal = startGoal(session, RUN_ID, objective);
    await session.settlePublications();
    return goal;
  }

  it('returns a rendered prompt when an active goal is present', async () => {
    await goalOnTheRun('Complete the refactor until pnpm test passes');
    const out = await maybeBuildGoalContinuation(session, RUN_ID);
    expect(out).toMatch(/<goal_context>/);
    expect(out).toContain('Complete the refactor until pnpm test passes');
    expect(out).toContain('Autonomous objective active');
    // The continuation no longer advertises the model-callable exit verbs;
    // it steers toward persistence instead.
    expect(out).not.toContain('plan(command="complete")');
    expect(out).not.toContain('plan(command="pause")');
  });

  it('renders an objective containing nunjucks-significant syntax as literal text', async () => {
    // The objective is a context *value* substituted into the template, not
    // concatenated into the template source — nunjucks must not re-parse it
    // as template syntax (no injection, no `{{ 1 + 1 }}` evaluating to `2`).
    const objective =
      'Finish {% for x in y %}{{ 1 + 1 }}{# comment #}{% endfor %} the "quoted" \\task\\.';
    await goalOnTheRun(objective);
    const out = await maybeBuildGoalContinuation(session, RUN_ID);
    expect(out).toContain(objective);
  });

  it('continues rendering after more than two hours elapsed', async () => {
    const goal = await goalOnTheRun(
      'Keep solving the hard problem until verification is complete.',
    );
    // The row's own start time, so the elapsed span is exact.
    const startedAt = Date.parse(goal.startedAt);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(
        new Date(startedAt + 2 * 60 * 60 * 1000 + 5 * 60 * 1000 + 1234),
      );
      const out = await maybeBuildGoalContinuation(session, RUN_ID);

      expect(out).toContain('<goal_context>');
      expect(out).toContain(
        'Keep solving the hard problem until verification is complete.',
      );
      expect(out).toContain('Time elapsed: 2h 5m');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when the feature flag is off (with an active goal present)', async () => {
    await goalOnTheRun('objective');
    // Flip just the flag — the goal row is untouched, so the test does not
    // pass trivially.
    (workspaceRoots().config as FakeConfigProvider).set(
      GOAL_FEATURE_FLAG_KEY,
      false,
    );
    expect(await maybeBuildGoalContinuation(session, RUN_ID)).toBeNull();
  });

  it('returns null when no goal exists for the stream', async () => {
    await expect(
      maybeBuildGoalContinuation(session, RUN_ID),
    ).resolves.toBeNull();
  });

  it('returns null when the goal is paused', async () => {
    await goalOnTheRun('objective');
    pauseGoal(session, RUN_ID);
    await session.settlePublications();

    await expect(
      maybeBuildGoalContinuation(session, RUN_ID),
    ).resolves.toBeNull();
  });

  it('is a pure read — leaves the goal untouched', async () => {
    const before = await goalOnTheRun('objective');
    await maybeBuildGoalContinuation(session, RUN_ID);
    await session.settlePublications();
    // No counter, no audit log: the helper only reads. The loop runs until
    // the model completes or the user stops it.
    expect(goalOf(session, RUN_ID)).toEqual(before);
  });
});
