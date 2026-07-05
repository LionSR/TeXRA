import { describe, expect, it } from 'vitest';

import { platform } from '@platform/platform';
import { installPlatform } from '@test/support/setupPlatform';
import type { StreamTabId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';

const STREAM_ID = 'stream:legacy-goal' as StreamTabId;
const NOW = '2026-06-09T00:00:00.000Z';

function legacyOdyssey(status: 'active' | 'paused' | 'complete' | 'abandoned') {
  return {
    odysseyId: 'ody_legacy123',
    streamId: STREAM_ID,
    objective: 'finish the proof',
    status,
    continuationCount: 3,
    maxContinuations: 50,
    createdAt: NOW,
    updatedAt: NOW,
    completedReason: null,
    history: [],
    plan: null,
  };
}

describe('GoalStore legacy Odyssey migration', () => {
  it('reads active legacy Odyssey records as live goals', async () => {
    await installPlatform({
      workspaceState: {
        [`odysseys:byStream:${STREAM_ID}`]: legacyOdyssey('active'),
        'odysseys:index': [STREAM_ID],
      },
    });

    const goal = GoalStore.getForStream(STREAM_ID);

    expect(goal).toMatchObject({
      goalId: 'ody_legacy123',
      streamId: STREAM_ID,
      objective: 'finish the proof',
      status: 'active',
    });
    expect(GoalStore.list().map((g) => g.streamId)).toEqual([STREAM_ID]);
  });

  it('drops terminal legacy Odyssey records from the live goal surface', async () => {
    await installPlatform({
      workspaceState: {
        [`odysseys:byStream:${STREAM_ID}`]: legacyOdyssey('complete'),
        'odysseys:index': [STREAM_ID],
      },
    });

    expect(GoalStore.getForStream(STREAM_ID)).toBeNull();
    expect(GoalStore.list()).toEqual([]);

    const next = await GoalStore.start(STREAM_ID, 'new objective');
    expect(next.status).toBe('active');
    expect(
      platform().workspaceState.get(`goals:byStream:${STREAM_ID}`),
    ).toMatchObject({
      objective: 'new objective',
    });
  });
});
