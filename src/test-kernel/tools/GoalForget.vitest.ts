import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import type { StreamTabId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';

const STREAM_A = 'stream:forget-a' as StreamTabId;
const STREAM_B = 'stream:forget-b' as StreamTabId;

describe('GoalStore.forget (abandon-on-delete contract)', () => {
  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}));
  });

  afterEach(async () => {
    await GoalStore.forget(STREAM_A);
    await GoalStore.forget(STREAM_B);
  });

  it('removes the per-stream record and clears the index entry', async () => {
    await GoalStore.start(STREAM_A, 'objective a');
    await GoalStore.start(STREAM_B, 'objective b');
    expect(
      GoalStore.list()
        .map((o) => o.streamId)
        .sort(),
    ).toEqual([STREAM_A, STREAM_B].sort());

    await GoalStore.forget(STREAM_A);

    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
    expect(GoalStore.list().map((o) => o.streamId)).toEqual([STREAM_B]);
  });

  it('is idempotent — forgetting an unknown stream is a no-op', async () => {
    await expect(GoalStore.forget(STREAM_A)).resolves.toBeUndefined();
  });

  it('lets the same streamId start a fresh goal after forget', async () => {
    await GoalStore.start(STREAM_A, 'objective one');
    await GoalStore.forget(STREAM_A);
    const next = await GoalStore.start(STREAM_A, 'objective two');
    expect(next.objective).toBe('objective two');
    expect(next.status).toBe('active');
  });
});
