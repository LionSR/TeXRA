import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import { platform, type Platform } from '@platform/platform';
import type { StreamTabId } from '@shared/schemas';
import { GOAL_FEATURE_FLAG_KEY } from '@shared/schemas/goal';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { GoalStore, isGoalEnabled } from '@tools/goal';

const STREAM_ID = 'stream:goal-cont' as StreamTabId;

async function installPlatformWithConfig(
  config: Record<string, unknown>,
): Promise<Platform> {
  await installFakePlatform({ config });
  return platform();
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
  beforeEach(async () => {
    await installPlatformWithConfig({ [GOAL_FEATURE_FLAG_KEY]: true });
  });

  afterEach(async () => {
    await GoalStore.forget(STREAM_ID);
  });

  it('returns a rendered prompt when an active goal is present', async () => {
    await GoalStore.start(
      STREAM_ID,
      'Complete the refactor until pnpm test passes',
    );
    const out = await maybeBuildGoalContinuation(STREAM_ID);
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
    await GoalStore.start(STREAM_ID, objective);
    const out = await maybeBuildGoalContinuation(STREAM_ID);
    expect(out).toContain(objective);
  });

  it('continues rendering after more than two hours elapsed', async () => {
    const startedAt = new Date('2026-06-17T00:00:00.000Z');
    const afterTwoHours = new Date(
      startedAt.getTime() + 2 * 60 * 60 * 1000 + 5 * 60 * 1000 + 1234,
    );

    vi.useFakeTimers();
    try {
      vi.setSystemTime(startedAt);
      await GoalStore.start(
        STREAM_ID,
        'Keep solving the hard problem until verification is complete.',
      );

      vi.setSystemTime(afterTwoHours);
      const out = await maybeBuildGoalContinuation(STREAM_ID);

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
    await GoalStore.start(STREAM_ID, 'objective');
    // Flip just the flag — keep the same workspaceState so the active
    // goal is still on disk. Otherwise the test passes trivially.
    (platform().config as FakeConfigProvider).set(GOAL_FEATURE_FLAG_KEY, false);
    const out = await maybeBuildGoalContinuation(STREAM_ID);
    expect(out).toBeNull();
    // Sanity: the record still exists; only the flag stopped the loop.
    expect(GoalStore.getForStream(STREAM_ID)?.status).toBe('active');
  });

  it('returns null when no goal exists for the stream', async () => {
    await expect(maybeBuildGoalContinuation(STREAM_ID)).resolves.toBeNull();
  });

  it('returns null when the goal is paused', async () => {
    await GoalStore.start(STREAM_ID, 'objective');
    await GoalStore.setStatus(STREAM_ID, 'paused');

    await expect(maybeBuildGoalContinuation(STREAM_ID)).resolves.toBeNull();
  });

  it('is a pure read — leaves the record untouched', async () => {
    const before = await GoalStore.start(STREAM_ID, 'objective');
    await maybeBuildGoalContinuation(STREAM_ID);
    const after = GoalStore.getForStream(STREAM_ID);
    // No counter, no audit log: the helper only reads. The loop runs until
    // the model completes or the user stops it.
    expect(after?.status).toBe('active');
    expect(after?.updatedAt).toBe(before.updatedAt);
  });
});
