// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import type { StateStore } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { GoalStore } from '@tools/goal';

const STREAM_A = 'stream:concurrent-goal-a' as StreamTabId;
const STREAM_B = 'stream:concurrent-goal-b' as StreamTabId;

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

describe('GoalStore index concurrency', () => {
  it('keeps both entries when concurrent start() calls overlap during the index write', async () => {
    const state = new BlockingFirstIndexWriteState();
    await installPlatform({}, { workspaceState: state });

    const firstStart = GoalStore.start(STREAM_A, 'objective a');
    await state.waitForBlockedIndexWrite();

    const secondStart = GoalStore.start(STREAM_B, 'objective b');
    await Promise.resolve();

    state.releaseBlockedIndexWrite();
    await Promise.all([firstStart, secondStart]);

    expect(
      GoalStore.list()
        .map((goal) => goal.streamId)
        .toSorted(),
    ).toEqual([STREAM_A, STREAM_B].toSorted());
    expect(state.get<StreamTabId[]>('goals:index', []).toSorted()).toEqual(
      [STREAM_A, STREAM_B].toSorted(),
    );
  });
});
