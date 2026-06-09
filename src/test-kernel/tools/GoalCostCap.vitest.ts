import { afterEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import type { StreamTabId } from '@shared/schemas';
import { GOAL_COST_CAP_CONFIG_KEY, GoalStore } from '@tools/goal';

const STREAM_ID = 'stream:goal-cost-cap' as StreamTabId;

async function installPlatform(costCapUsd?: number): Promise<void> {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform({
      config:
        costCapUsd === undefined
          ? {}
          : { [GOAL_COST_CAP_CONFIG_KEY]: costCapUsd },
    }),
  );
}

describe('GoalStore cost cap', () => {
  afterEach(async () => {
    await GoalStore.forget(STREAM_ID);
  });

  it('start snapshots the configured cap; 0/unset means unbounded', async () => {
    await installPlatform(2.5);
    const capped = await GoalStore.start(STREAM_ID, 'objective');
    expect(capped.costCapUsd).toBe(2.5);
    expect(capped.spentUsd).toBe(0);
    expect(capped.baselineRunCostUsd).toBeNull();
    await GoalStore.forget(STREAM_ID);

    await installPlatform(0);
    const unbounded = await GoalStore.start(STREAM_ID, 'objective');
    expect(unbounded.costCapUsd).toBeNull();
  });

  it('noteRunCost baselines on first observation so pre-goal spend is excluded', async () => {
    await installPlatform(10);
    await GoalStore.start(STREAM_ID, 'objective');

    // First note: $4 was already spent in the conversation before the goal.
    const first = await GoalStore.noteRunCost(STREAM_ID, 4);
    expect(first?.goal.baselineRunCostUsd).toBe(4);
    expect(first?.goal.spentUsd).toBe(0);
    expect(first?.pausedForCap).toBe(false);

    // Later notes count only the delta above the baseline.
    const second = await GoalStore.noteRunCost(STREAM_ID, 7.25);
    expect(second?.goal.spentUsd).toBeCloseTo(3.25);
    expect(second?.goal.status).toBe('active');
  });

  it('pauses the goal exactly once when spend reaches the cap', async () => {
    await installPlatform(1);
    await GoalStore.start(STREAM_ID, 'objective');
    await GoalStore.noteRunCost(STREAM_ID, 0.5); // baseline

    const tripped = await GoalStore.noteRunCost(STREAM_ID, 1.6);
    expect(tripped?.pausedForCap).toBe(true);
    expect(tripped?.goal.status).toBe('paused');
    expect(tripped?.goal.spentUsd).toBeCloseTo(1.1);

    // Already paused: subsequent notes never re-report the transition.
    const again = await GoalStore.noteRunCost(STREAM_ID, 1.7);
    expect(again?.pausedForCap).toBe(false);
    expect(again?.goal.status).toBe('paused');

    const resumed = await GoalStore.setStatus(STREAM_ID, 'active');
    expect(resumed?.baselineRunCostUsd).toBeNull();
    expect(resumed?.spentUsd).toBe(0);

    const resumedBaseline = await GoalStore.noteRunCost(STREAM_ID, 1.8);
    expect(resumedBaseline?.pausedForCap).toBe(false);
    expect(resumedBaseline?.goal.status).toBe('active');
    expect(resumedBaseline?.goal.baselineRunCostUsd).toBe(1.8);
    expect(resumedBaseline?.goal.spentUsd).toBe(0);

    const trippedAgain = await GoalStore.noteRunCost(STREAM_ID, 2.9);
    expect(trippedAgain?.pausedForCap).toBe(true);
    expect(trippedAgain?.goal.status).toBe('paused');
    expect(trippedAgain?.goal.spentUsd).toBeCloseTo(1.1);
  });

  it('never pauses without a cap and is a no-op without a goal', async () => {
    await installPlatform();
    await GoalStore.start(STREAM_ID, 'objective');
    await GoalStore.noteRunCost(STREAM_ID, 1);
    const result = await GoalStore.noteRunCost(STREAM_ID, 500);
    expect(result?.goal.status).toBe('active');
    expect(result?.goal.spentUsd).toBe(499);
    expect(result?.pausedForCap).toBe(false);

    await GoalStore.forget(STREAM_ID);
    expect(await GoalStore.noteRunCost(STREAM_ID, 1)).toBeNull();
  });
});
