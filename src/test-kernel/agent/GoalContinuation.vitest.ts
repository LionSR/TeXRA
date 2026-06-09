// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  FakeConfigProvider,
  createFakePlatform,
} from '@test/support/FakePlatform';
import { maybeBuildGoalContinuation } from '@agent/goal';
import type { StreamTabId } from '@shared/schemas';
import {
  LEGACY_GOAL_FEATURE_FLAG_KEYS,
  GOAL_FEATURE_FLAG_KEY,
  GoalStore,
  isGoalEnabled,
} from '@tools/goal';
import type { Platform } from '@platform/platform';

const STREAM_ID = 'stream:goal-cont' as StreamTabId;
// Pre-rename canonical key, still honored read-only for back-compat.
const LEGACY_GOAL_FEATURE_FLAG_KEY = LEGACY_GOAL_FEATURE_FLAG_KEYS[0];

async function installPlatform(flagOn: boolean): Promise<Platform> {
  const { initPlatform } = await import('@platform/platform');
  const platform = createFakePlatform({
    config: { [GOAL_FEATURE_FLAG_KEY]: flagOn },
  });
  initPlatform(platform);
  return platform;
}

async function installPlatformWithConfig(
  config: Record<string, unknown>,
): Promise<Platform> {
  const { initPlatform } = await import('@platform/platform');
  const platform = createFakePlatform({ config });
  initPlatform(platform);
  return platform;
}

describe('isGoalEnabled', () => {
  it.each([
    {
      name: 'defaults on when neither key is set',
      config: {},
      expected: true,
    },
    {
      name: 'honors explicit canonical false',
      config: { [GOAL_FEATURE_FLAG_KEY]: false },
      expected: false,
    },
    {
      name: 'honors explicit legacy false when canonical is absent',
      config: { [LEGACY_GOAL_FEATURE_FLAG_KEY]: false },
      expected: false,
    },
    {
      name: 'honors explicit legacy true when canonical is absent',
      config: { [LEGACY_GOAL_FEATURE_FLAG_KEY]: true },
      expected: true,
    },
    {
      name: 'lets canonical true override legacy false',
      config: {
        [LEGACY_GOAL_FEATURE_FLAG_KEY]: false,
        [GOAL_FEATURE_FLAG_KEY]: true,
      },
      expected: true,
    },
    {
      name: 'lets canonical false override legacy true',
      config: {
        [LEGACY_GOAL_FEATURE_FLAG_KEY]: true,
        [GOAL_FEATURE_FLAG_KEY]: false,
      },
      expected: false,
    },
  ])('$name', async ({ config, expected }) => {
    await installPlatformWithConfig(config);

    expect(isGoalEnabled()).toBe(expected);
  });
});

describe('maybeBuildGoalContinuation', () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await installPlatform(true);
  });

  afterEach(async () => {
    await GoalStore.forget(STREAM_ID);
  });

  it('returns a rendered prompt when an active goal is present', async () => {
    await GoalStore.start(
      STREAM_ID,
      'Complete the refactor until pnpm test passes',
    );
    const out = await maybeBuildGoalContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toMatch(/<goal_context>/);
    expect(out).toContain('Complete the refactor until pnpm test passes');
    expect(out).toContain('Autonomous objective active');
    // The continuation no longer advertises the model-callable exit verbs;
    // it steers toward persistence instead.
    expect(out).not.toContain('plan(command="complete")');
    expect(out).not.toContain('plan(command="pause")');
  });

  it('returns null in subagent mode (parent owns continuation)', async () => {
    await GoalStore.start(STREAM_ID, 'objective');
    const out = await maybeBuildGoalContinuation({
      streamId: STREAM_ID,
      isSubagent: true,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it('returns null when user already queued a follow-up', async () => {
    await GoalStore.start(STREAM_ID, 'objective');
    const out = await maybeBuildGoalContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: true,
    });
    expect(out).toBeNull();
  });

  it('returns null when the feature flag is off (with an active goal present)', async () => {
    await GoalStore.start(STREAM_ID, 'objective');
    // Flip just the flag — keep the same workspaceState so the active
    // goal is still on disk. Otherwise the test passes trivially.
    (platform.config as FakeConfigProvider).set(GOAL_FEATURE_FLAG_KEY, false);
    const out = await maybeBuildGoalContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
    // Sanity: the record still exists; only the flag stopped the loop.
    expect(GoalStore.getForStream(STREAM_ID)?.status).toBe('active');
  });

  it('returns null when no goal exists for the stream', async () => {
    const out = await maybeBuildGoalContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it('returns null when the goal is paused', async () => {
    await GoalStore.start(STREAM_ID, 'objective');
    await GoalStore.setStatus(STREAM_ID, 'paused');
    const out = await maybeBuildGoalContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    expect(out).toBeNull();
  });

  it('is a pure read — leaves the record untouched', async () => {
    const before = await GoalStore.start(STREAM_ID, 'objective');
    await maybeBuildGoalContinuation({
      streamId: STREAM_ID,
      isSubagent: false,
      hasQueuedFollowUp: false,
    });
    const after = GoalStore.getForStream(STREAM_ID);
    // No counter, no audit log: the helper only reads. The loop runs until
    // the model completes or the user stops it.
    expect(after?.status).toBe('active');
    expect(after?.updatedAt).toBe(before.updatedAt);
  });
});
