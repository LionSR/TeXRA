// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { afterEach, describe, expect, it } from 'vitest';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

import { createRecordingHost } from '@test/agent/progressTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';

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

  it('treats only absent goal records as no goal', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    const key = `goals:byStream:${STREAM_A}`;

    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
    await state.update(key, null);
    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
  });

  it('routes explicit-session forget notifications only to the passed session', async () => {
    const runSession = createTestSession();
    const explicitSession = createTestSession();
    const seenRun: unknown[] = [];
    const seenExplicit: unknown[] = [];
    const seenDefault: unknown[] = [];
    const detachRun = subscribeGoalStateChanges(runSession, (change) => {
      seenRun.push(change);
    });
    const detachExplicit = subscribeGoalStateChanges(
      explicitSession,
      (change) => {
        seenExplicit.push(change);
      },
    );
    const detachDefault = subscribeGoalStateChanges(
      defaultSession(),
      (change) => {
        seenDefault.push(change);
      },
    );

    try {
      await withRunContext(
        createRunContext({
          runtimeHost: createRecordingHost().host,
          session: runSession,
        }),
        async () => {
          await GoalStore.start(STREAM_A, 'objective one');
        },
      );
      seenRun.length = 0;
      seenExplicit.length = 0;
      seenDefault.length = 0;

      await withRunContext(
        createRunContext({
          runtimeHost: createRecordingHost().host,
          session: runSession,
        }),
        async () => {
          await GoalStore.forget(STREAM_A, explicitSession);
        },
      );

      expect(seenRun).toEqual([]);
      expect(seenExplicit).toEqual([{ streamId: STREAM_A }]);
      expect(seenDefault).toEqual([]);
    } finally {
      detachRun();
      detachExplicit();
      detachDefault();
      runSession.dispose();
      explicitSession.dispose();
    }
  });

  it('surfaces an unparseable blob but still lets explicit cleanup remove it', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    await state.update(`goals:byStream:${STREAM_A}`, { goalId: 'not-valid' });
    expect(() => GoalStore.getForStream(STREAM_A)).toThrow(
      `Failed to parse persisted goal for stream "${STREAM_A}"`,
    );

    await GoalStore.forget(STREAM_A);

    expect(state.get(`goals:byStream:${STREAM_A}`)).toBeUndefined();
    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
  });

  it('does not overwrite an unparseable record when starting a goal', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    const malformed = { goalId: 'not-valid' };
    const key = `goals:byStream:${STREAM_A}`;
    await state.update(key, malformed);

    await expect(GoalStore.start(STREAM_A, 'replacement')).rejects.toThrow();
    expect(state.get(key)).toEqual(malformed);
  });

  it('identifies the malformed stream when listing goals', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    await state.update('goals:index', [STREAM_A]);
    await state.update(`goals:byStream:${STREAM_A}`, { goalId: 'not-valid' });

    expect(() => GoalStore.list()).toThrow(
      `Failed to parse persisted goal for stream "${STREAM_A}"`,
    );
  });

  it('forgetMany clears records and unparseable blobs', async () => {
    const { platform } = await import('@platform/platform');
    const state = platform().workspaceState;
    await GoalStore.start(STREAM_A, 'objective a');
    await state.update(`goals:byStream:${STREAM_B}`, { goalId: 'garbage' });

    await GoalStore.forgetMany([STREAM_A, STREAM_B]);

    expect(GoalStore.list()).toEqual([]);
    expect(state.get(`goals:byStream:${STREAM_B}`)).toBeUndefined();
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
