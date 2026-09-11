import '@test/support/defaultSessionTestSetup';

import { Effect, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { StateStore } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  aggregateId as qualifyAggregateId,
  RunIdSchema,
  type RunId,
} from '@shared/schemas';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { GoalStore, goalStateChanges } from '@tools/goal';

const RUN_A = RunIdSchema.parse('fa0000000a0a');
const RUN_B = RunIdSchema.parse('fa0000000b0b');
const SUBSCRIPTION_RUN = RunIdSchema.parse('5b5c00000001');
const CONCURRENT_RUN_A = RunIdSchema.parse('c0cca000000a');
const CONCURRENT_RUN_B = RunIdSchema.parse('c0cca000000b');
const SAME_SESSION_RUN = RunIdSchema.parse('5a3e00000001');
const OTHER_SESSION_RUN = RunIdSchema.parse('01e300000001');

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
/** The roots of one paper: a session's plane is keyed by its storage root. */
function paperRoots(name: string) {
  return createFakeWorkspaceRoots({
    storagePath: `/workspace/${name}/.texra/storage`,
  });
}

function collectGoalChanges(session: SessionHandle): {
  seen: unknown[];
  clear: () => void;
  detach: () => void;
} {
  const seen: unknown[] = [];
  const fiber = effectRuntime().runFork(
    Stream.runForEach(goalStateChanges(session), (change) =>
      Effect.sync(() => {
        seen.push(change);
      }),
    ),
  );
  return {
    seen,
    clear: () => {
      seen.length = 0;
    },
    detach: () => {
      effectRuntime().runFork(Fiber.interrupt(fiber));
    },
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
    await GoalStore.forget(RUN_A);
    await GoalStore.forget(RUN_B);
  });

  it('removes the per-stream record and clears the index entry', async () => {
    await GoalStore.start(RUN_A, 'objective a');
    await GoalStore.start(RUN_B, 'objective b');
    expect(
      GoalStore.list()
        .map((o) => o.runId)
        .sort(),
    ).toEqual([RUN_A, RUN_B].sort());

    await GoalStore.forget(RUN_A);

    expect(GoalStore.getForRun(RUN_A)).toBeNull();
    expect(GoalStore.list().map((o) => o.runId)).toEqual([RUN_B]);
  });

  it('lets the same runId start a fresh goal after forget', async () => {
    await GoalStore.start(RUN_A, 'objective one');
    await GoalStore.forget(RUN_A);
    const next = await GoalStore.start(RUN_A, 'objective two');
    expect(next.objective).toBe('objective two');
    expect(next.status).toBe('active');
  });

  it('treats only absent goal records as no goal', async () => {
    const state = workspaceRoots().workspaceState;
    const key = `goals:byRun:${RUN_A}`;

    expect(GoalStore.getForRun(RUN_A)).toBeNull();
    await state.update(key, null);
    expect(GoalStore.getForRun(RUN_A)).toBeNull();
  });

  it('routes explicit-session forget notifications only to the passed session', async () => {
    const runSession = createTestSession({ roots: paperRoots('run') });
    const explicitSession = createTestSession({
      roots: paperRoots('explicit'),
    });
    publishTestRunStart(runSession, RUN_A);
    publishTestRunStart(explicitSession, RUN_A);
    const run = collectGoalChanges(runSession);
    const explicit = collectGoalChanges(explicitSession);
    const fallback = collectGoalChanges(defaultSession());

    try {
      await inSession(runSession, () =>
        GoalStore.start(RUN_A, 'objective one'),
      );
      await runSession.settlePublications();
      run.clear();
      explicit.clear();
      fallback.clear();

      await inSession(runSession, () =>
        GoalStore.forget(RUN_A, explicitSession),
      );
      await explicitSession.settlePublications();

      expect(run.seen).toEqual([]);
      expect(explicit.seen).toEqual([{ runId: RUN_A }]);
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
    const state = workspaceRoots().workspaceState;
    await state.update(`goals:byRun:${RUN_A}`, { goalId: 'not-valid' });
    expect(() => GoalStore.getForRun(RUN_A)).toThrow(
      `Failed to parse persisted goal for run "${RUN_A}"`,
    );

    await GoalStore.forget(RUN_A);

    expect(state.get(`goals:byRun:${RUN_A}`)).toBeUndefined();
    expect(GoalStore.getForRun(RUN_A)).toBeNull();
  });

  it('does not overwrite an unparseable record when starting a goal', async () => {
    const state = workspaceRoots().workspaceState;
    const malformed = { goalId: 'not-valid' };
    const key = `goals:byRun:${RUN_A}`;
    await state.update(key, malformed);

    await expect(GoalStore.start(RUN_A, 'replacement')).rejects.toThrow();
    expect(state.get(key)).toEqual(malformed);
  });

  it('identifies the malformed stream when listing goals', async () => {
    const state = workspaceRoots().workspaceState;
    await state.update('goals:index', [RUN_A]);
    await state.update(`goals:byRun:${RUN_A}`, { goalId: 'not-valid' });

    expect(() => GoalStore.list()).toThrow(
      `Failed to parse persisted goal for run "${RUN_A}"`,
    );
  });

  it('forgetMany clears records and unparseable blobs', async () => {
    const state = workspaceRoots().workspaceState;
    await GoalStore.start(RUN_A, 'objective a');
    await state.update(`goals:byRun:${RUN_B}`, { goalId: 'garbage' });

    await GoalStore.forgetMany([RUN_A, RUN_B]);

    expect(GoalStore.list()).toEqual([]);
    expect(state.get(`goals:byRun:${RUN_B}`)).toBeUndefined();
    expect(GoalStore.getForRun(RUN_A)).toBeNull();
  });
});

describe('goalStateChanges', () => {
  setupPlatform();

  it('delivers only goal changes from the supplied session', async () => {
    // Two papers: a session's plane is its workspace root's.
    const sessionA = createTestSession({ roots: paperRoots('a') });
    const sessionB = createTestSession({ roots: paperRoots('b') });
    publishTestRunStart(sessionA, SAME_SESSION_RUN);
    publishTestRunStart(sessionB, OTHER_SESSION_RUN);
    const { seen, detach } = collectGoalChanges(sessionA);

    try {
      sessionB.publish([
        {
          type: 'goalStateChanged',
          aggregateId: qualifyAggregateId('run', OTHER_SESSION_RUN),
          state: { active: false },
        },
      ]);
      sessionA.publish([
        {
          type: 'updateRunDescription',
          aggregateId: qualifyAggregateId('run', SAME_SESSION_RUN),
          description: 'not a goal change',
        },
      ]);
      sessionA.publish([
        {
          type: 'goalStateChanged',
          aggregateId: qualifyAggregateId('run', SAME_SESSION_RUN),
          state: { active: false },
        },
      ]);
      await Promise.all([
        sessionA.settlePublications(),
        sessionB.settlePublications(),
      ]);

      expect(seen).toEqual([{ runId: SAME_SESSION_RUN }]);
      await withRunContext(createRunContext({ session: sessionA }), () =>
        GoalStore.start(SAME_SESSION_RUN, 'Determine the boundary conditions.'),
      );
      await sessionA.settlePublications();
      const removed = effectRuntime().runPromise(
        Stream.runHead(
          goalStateChanges(sessionA).pipe(
            Stream.map((change) =>
              withRunContext(createRunContext({ session: sessionA }), () =>
                GoalStore.getForRun(change.runId),
              ),
            ),
          ),
        ),
      );
      sessionA.publish([
        {
          type: 'run.removed',
          aggregateId: qualifyAggregateId('run', SAME_SESSION_RUN),
        },
      ]);
      expect(await removed).toMatchObject({ _tag: 'Some', value: null });
    } finally {
      detach();
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('routes start, status, and edit notifications through the current run session only', async () => {
    const runSession = createTestSession({ roots: paperRoots('run') });
    const otherSession = createTestSession({ roots: paperRoots('other') });
    publishTestRunStart(runSession, SUBSCRIPTION_RUN);
    const run = collectGoalChanges(runSession);
    const other = collectGoalChanges(otherSession);
    const fallback = collectGoalChanges(defaultSession());

    try {
      await inSession(runSession, async () => {
        await GoalStore.start(SUBSCRIPTION_RUN, 'prove the estimate');
        await GoalStore.setStatus(SUBSCRIPTION_RUN, 'paused');
        await GoalStore.editObjective(
          SUBSCRIPTION_RUN,
          'prove the sharp estimate',
        );
      });
      await runSession.settlePublications();

      expect(run.seen).toEqual([
        { runId: SUBSCRIPTION_RUN },
        { runId: SUBSCRIPTION_RUN },
        { runId: SUBSCRIPTION_RUN },
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

    const firstStart = GoalStore.start(CONCURRENT_RUN_A, 'objective a');
    await state.waitForBlockedIndexWrite();

    const secondStart = GoalStore.start(CONCURRENT_RUN_B, 'objective b');
    await Promise.resolve();

    state.releaseBlockedIndexWrite();
    await Promise.all([firstStart, secondStart]);

    expect(
      GoalStore.list()
        .map((goal) => goal.runId)
        .toSorted(),
    ).toEqual([CONCURRENT_RUN_A, CONCURRENT_RUN_B].toSorted());
    expect(state.get<RunId[]>('goals:index', []).toSorted()).toEqual(
      [CONCURRENT_RUN_A, CONCURRENT_RUN_B].toSorted(),
    );
  });
});
