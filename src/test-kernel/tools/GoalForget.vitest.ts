import { afterEach, describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';

const STREAM_A = 'stream:forget-a' as StreamTabId;
const STREAM_B = 'stream:forget-b' as StreamTabId;

describe('GoalStore.forget (abandon-on-delete contract)', () => {
  setupPlatform();

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

  it('cleans up an unparseable legacy blob (raw key presence, not parse success)', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    // A terminal-status legacy record normalizes to null on read, but its
    // raw key must still be removed by forget.
    await state.update(`odysseys:byStream:${STREAM_A}`, {
      odysseyId: 'ody_terminal',
      status: 'complete',
    });
    expect(GoalStore.getForStream(STREAM_A)).toBeNull();

    await GoalStore.forget(STREAM_A);

    expect(state.get(`odysseys:byStream:${STREAM_A}`)).toBeUndefined();
  });

  it('clears the legacy odysseys:index so removed entries cannot resurface', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    const legacy = (streamId: StreamTabId) => ({
      odysseyId: `ody_${streamId}`,
      streamId,
      objective: 'legacy objective',
      status: 'active',
      createdAt: '2026-06-09T00:00:00.000Z',
      updatedAt: '2026-06-09T00:00:00.000Z',
      plan: null,
    });
    await state.update('odysseys:index', [STREAM_A, STREAM_B]);
    await state.update(`odysseys:byStream:${STREAM_A}`, legacy(STREAM_A));
    await state.update(`odysseys:byStream:${STREAM_B}`, legacy(STREAM_B));

    await GoalStore.forget(STREAM_A);

    // The legacy index is dropped and survivors migrate into the new index,
    // so the forgotten entry cannot resurface through the union read.
    expect(state.get('odysseys:index')).toBeUndefined();
    expect(GoalStore.list().map((g) => g.streamId)).toEqual([STREAM_B]);
    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
  });

  it('forgetMany clears records, both indexes, and unparseable blobs', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    await GoalStore.start(STREAM_A, 'objective a');
    await state.update('odysseys:index', [STREAM_B]);
    await state.update(`odysseys:byStream:${STREAM_B}`, {
      odysseyId: 'ody_garbage',
    });

    await GoalStore.forgetMany([STREAM_A, STREAM_B]);

    expect(GoalStore.list()).toEqual([]);
    expect(state.get('odysseys:index')).toBeUndefined();
    expect(state.get(`odysseys:byStream:${STREAM_B}`)).toBeUndefined();
    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
  });

  it('forgets indexed streams owned by deleted execution ids, including unparseable blobs', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    const deleted = 'abc123' as ExecutionId;
    const kept = 'def456' as ExecutionId;
    const deletedStream = `chat@deepseek#${deleted}` as StreamTabId;
    const keptStream = `chat@deepseek#${kept}` as StreamTabId;

    await state.update('goals:index', [deletedStream, keptStream]);
    await state.update(`goals:byStream:${deletedStream}`, {
      goalId: 'not-a-valid-goal',
    });
    await GoalStore.start(keptStream, 'keep this goal');

    await GoalStore.forgetByExecutionIds([deleted]);

    expect(state.get(`goals:byStream:${deletedStream}`)).toBeUndefined();
    expect(GoalStore.getForStream(keptStream)?.objective).toBe(
      'keep this goal',
    );
    expect(GoalStore.list().map((g) => g.streamId)).toEqual([keptStream]);
  });
});
