import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { StateStore } from '@platform/interfaces';
import { platform } from '@platform/platform';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';

const STREAM_A = 'stream:forget-a' as StreamTabId;
const STREAM_B = 'stream:forget-b' as StreamTabId;
const SUBSCRIPTION_STREAM = 'stream:goal-state-subscription' as StreamTabId;
const CONCURRENT_STREAM_A = 'stream:concurrent-goal-a' as StreamTabId;
const CONCURRENT_STREAM_B = 'stream:concurrent-goal-b' as StreamTabId;

class BlockingFirstIndexWriteState implements StateStore {
  private readonly values = new Map<string, unknown>();

  private pendingIndexWrite: {
    value: unknown;
    resolve: () => void;
  } | null = null;

  private readonly pendingWaiters: Array<() => void> = [];

  private shouldBlockNextIndexWrite = true;

  get<T>(key: string, defaultValue?: T): T {
    if (!this.values.has(key)) {
      return defaultValue as T;
    }
    return this.values.get(key) as T;
  }

  update(key: string, value: unknown): Promise<void> {
    if (key === 'goals:index' && this.shouldBlockNextIndexWrite) {
      this.shouldBlockNextIndexWrite = false;
      return new Promise((resolve) => {
        this.pendingIndexWrite = { value, resolve };
        for (const waiter of this.pendingWaiters.splice(0)) waiter();
      });
    }

    this.applyUpdate(key, value);
    return Promise.resolve();
  }

  waitForBlockedIndexWrite(): Promise<void> {
    if (this.pendingIndexWrite) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pendingWaiters.push(resolve);
    });
  }

  releaseBlockedIndexWrite(): void {
    if (!this.pendingIndexWrite) {
      throw new Error('No blocked index write to release.');
    }
    const pending = this.pendingIndexWrite;
    this.pendingIndexWrite = null;
    this.applyUpdate('goals:index', pending.value);
    pending.resolve();
  }

  private applyUpdate(key: string, value: unknown): void {
    if (value === undefined) {
      this.values.delete(key);
      return;
    }
    this.values.set(key, value);
  }
}

/** Records every goal-state change delivered to one session. */
function collectGoalChanges(session: SessionHandle): {
  seen: unknown[];
  clear: () => void;
  detach: () => void;
} {
  const seen: unknown[] = [];
  const detach = subscribeGoalStateChanges(session, (change) => {
    seen.push(change);
  });
  return {
    seen,
    clear: () => {
      seen.length = 0;
    },
    detach,
  };
}

async function inSession(
  session: SessionHandle,
  run: () => Promise<unknown>,
): Promise<unknown> {
  return withRunContext(createRunContext({ session }), run);
}

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
    const state = platform().workspaceState;
    const key = `goals:byStream:${STREAM_A}`;

    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
    await state.update(key, null);
    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
  });

  it('routes explicit-session forget notifications only to the passed session', async () => {
    const runSession = createTestSession();
    const explicitSession = createTestSession();
    const run = collectGoalChanges(runSession);
    const explicit = collectGoalChanges(explicitSession);
    const fallback = collectGoalChanges(defaultSession());

    try {
      await inSession(runSession, () =>
        GoalStore.start(STREAM_A, 'objective one'),
      );
      run.clear();
      explicit.clear();
      fallback.clear();

      await inSession(runSession, () =>
        GoalStore.forget(STREAM_A, explicitSession),
      );

      expect(run.seen).toEqual([]);
      expect(explicit.seen).toEqual([{ streamId: STREAM_A }]);
      expect(fallback.seen).toEqual([]);
    } finally {
      run.detach();
      explicit.detach();
      fallback.detach();
      runSession.dispose();
      explicitSession.dispose();
    }
  });

  it('surfaces an unparseable blob but still lets explicit cleanup remove it', async () => {
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
    const state = platform().workspaceState;
    const malformed = { goalId: 'not-valid' };
    const key = `goals:byStream:${STREAM_A}`;
    await state.update(key, malformed);

    await expect(GoalStore.start(STREAM_A, 'replacement')).rejects.toThrow();
    expect(state.get(key)).toEqual(malformed);
  });

  it('identifies the malformed stream when listing goals', async () => {
    const state = platform().workspaceState;
    await state.update('goals:index', [STREAM_A]);
    await state.update(`goals:byStream:${STREAM_A}`, { goalId: 'not-valid' });

    expect(() => GoalStore.list()).toThrow(
      `Failed to parse persisted goal for stream "${STREAM_A}"`,
    );
  });

  it('forgetMany clears records and unparseable blobs', async () => {
    const state = platform().workspaceState;
    await GoalStore.start(STREAM_A, 'objective a');
    await state.update(`goals:byStream:${STREAM_B}`, { goalId: 'garbage' });

    await GoalStore.forgetMany([STREAM_A, STREAM_B]);

    expect(GoalStore.list()).toEqual([]);
    expect(state.get(`goals:byStream:${STREAM_B}`)).toBeUndefined();
    expect(GoalStore.getForStream(STREAM_A)).toBeNull();
  });

  it('forgets indexed streams owned by deleted execution ids, including unparseable blobs', async () => {
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

describe('subscribeGoalStateChanges', () => {
  setupPlatform();

  it('delivers only goal changes from the supplied session', () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();
    const { seen, detach } = collectGoalChanges(sessionA);

    try {
      sessionB.events.emit({
        scope: 'session',
        event: {
          type: 'goalStateChanged',
          payload: { streamId: 'other-session' as StreamTabId },
        },
      });
      sessionA.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId: 'same-session' as StreamTabId },
        },
      });
      sessionA.events.emit({
        scope: 'session',
        event: {
          type: 'goalStateChanged',
          payload: { streamId: 'same-session' as StreamTabId },
        },
      });

      expect(seen).toEqual([{ streamId: 'same-session' }]);
    } finally {
      detach();
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('routes start, status, and edit notifications through the current run session only', async () => {
    const runSession = createTestSession();
    const otherSession = createTestSession();
    const run = collectGoalChanges(runSession);
    const other = collectGoalChanges(otherSession);
    const fallback = collectGoalChanges(defaultSession());

    try {
      await inSession(runSession, async () => {
        await GoalStore.start(SUBSCRIPTION_STREAM, 'prove the estimate');
        await GoalStore.setStatus(SUBSCRIPTION_STREAM, 'paused');
        await GoalStore.editObjective(
          SUBSCRIPTION_STREAM,
          'prove the sharp estimate',
        );
      });

      expect(run.seen).toEqual([
        { streamId: SUBSCRIPTION_STREAM },
        { streamId: SUBSCRIPTION_STREAM },
        { streamId: SUBSCRIPTION_STREAM },
      ]);
      expect(other.seen).toEqual([]);
      expect(fallback.seen).toEqual([]);
    } finally {
      run.detach();
      other.detach();
      fallback.detach();
      runSession.dispose();
      otherSession.dispose();
    }
  });
});

describe('GoalStore index concurrency', () => {
  it('keeps both entries when concurrent start() calls overlap during the index write', async () => {
    const state = new BlockingFirstIndexWriteState();
    await installPlatform({}, { workspaceState: state });

    const firstStart = GoalStore.start(CONCURRENT_STREAM_A, 'objective a');
    await state.waitForBlockedIndexWrite();

    const secondStart = GoalStore.start(CONCURRENT_STREAM_B, 'objective b');
    await Promise.resolve();

    state.releaseBlockedIndexWrite();
    await Promise.all([firstStart, secondStart]);

    expect(
      GoalStore.list()
        .map((goal) => goal.streamId)
        .toSorted(),
    ).toEqual([CONCURRENT_STREAM_A, CONCURRENT_STREAM_B].toSorted());
    expect(state.get<StreamTabId[]>('goals:index', []).toSorted()).toEqual(
      [CONCURRENT_STREAM_A, CONCURRENT_STREAM_B].toSorted(),
    );
  });
});
