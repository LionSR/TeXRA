// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';
import { z, type ZodType } from 'zod';

import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { Lifecycle } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import { FakeSecrets } from '@test/support/FakePlatform';
// Local imports - tools
import { getNewestTimestamp } from '@tools/github/githubPaths';
import {
  DedupedResource,
  PollingSourceBase,
  createBasePollState,
  type BasePollSubscriptionState,
  type PollHookRejected,
} from '@tools/github/PollingSourceBase';
import type { ConditionalResponse } from '@tools/github/githubClient';

interface TestItem {
  id: number;
  created_at: string;
  updated_at?: string | null;
}

class TestPollingSource extends PollingSourceBase<
  string,
  BasePollSubscriptionState
> {
  constructor() {
    super({
      name: 'TestPollingSource',
      pollIntervalMs: 10_000,
      maxConcurrent: 1,
      backoffBaseMs: 1_000,
      backoffMaxMs: 10_000,
      maxFailureDurationMs: 60_000,
    });
  }

  validate<T>(
    res: ConditionalResponse<unknown>,
    schema: ZodType<T>,
  ): ConditionalResponse<T> | undefined {
    return this.validateOrSkip(res, schema, 'bad payload');
  }

  setWarnForTest(warn: typeof this.logger.warn): void {
    this.logger.warn = warn;
  }

  subscribeForTest(listener: (text: string) => Effect.Effect<void>) {
    return this.register('key', createBasePollState, listener);
  }

  emitForTest(text: string): Effect.Effect<void> {
    const state = this.getSubscriptionState('key');
    return state ? this.emit(state, text) : Effect.void;
  }

  protected pollOne(): Effect.Effect<void, PollHookRejected> {
    return Effect.void;
  }

  protected formatErrorEvent(): string {
    return 'subscription error';
  }
}

describe('DedupedResource', () => {
  it('seeds seen ids, emits only newly seen items, advances cursor, and trims', () => {
    const resource = new DedupedResource<TestItem>({
      getId: (item) => item.id,
      getCursor: getNewestTimestamp,
      maxSeenIds: 3,
      sinceCursor: '2026-07-04T00:00:00Z',
    });

    resource.seed([
      { id: 1, created_at: '2026-07-04T00:00:01Z' },
      { id: 2, created_at: '2026-07-04T00:00:02Z' },
    ]);

    expect(new Set(resource.seenIds)).toEqual(new Set([1, 2]));
    expect(resource.sinceCursor).toBe('2026-07-04T00:00:02Z');

    const emitted: number[] = [];
    resource.diff(
      [
        { id: 2, created_at: '2026-07-04T00:00:03Z' },
        { id: 3, created_at: '2026-07-04T00:00:04Z' },
        { id: 4, created_at: '2026-07-04T00:00:05Z' },
      ],
      (item) => emitted.push(item.id),
    );

    expect(emitted).toEqual([3, 4]);
    expect(resource.sinceCursor).toBe('2026-07-04T00:00:05Z');
    expect(new Set(resource.seenIds)).toEqual(new Set([2, 3, 4]));
  });

  it('does not re-emit an already-seen id evicted mid-batch by later new ids', () => {
    // Regression: seenIds is now backed by an LRU cache that can evict as
    // soon as an `add()` pushes it over cap, instead of trimming once after
    // the whole batch. If `diff()` re-checked `has()` against that
    // continuously-evicting cache, a batch fetched sort=updated&direction=asc
    // (GitHub's poll order) where several brand-new items push a previously
    // seen id out of the cache before the loop reaches that id's own
    // (edited) occurrence later in the same page would treat it as new and
    // re-emit it.
    const resource = new DedupedResource<TestItem>({
      getId: (item) => item.id,
      maxSeenIds: 3,
    });

    resource.seed([{ id: 1, created_at: '2026-07-04T00:00:00Z' }]);

    const emitted: number[] = [];
    resource.diff(
      [
        { id: 2, created_at: '2026-07-04T00:00:01Z' },
        { id: 3, created_at: '2026-07-04T00:00:02Z' },
        { id: 4, created_at: '2026-07-04T00:00:03Z' },
        // Edited older comment: same id already seen in the prior tick, but
        // resorts to the end of this ascending-by-updated_at page.
        { id: 1, created_at: '2026-07-04T00:00:00Z' },
      ],
      (item) => emitted.push(item.id),
    );

    expect(emitted).toEqual([2, 3, 4]);
  });
});

describe('PollingSourceBase.validateOrSkip', () => {
  it('logs and skips malformed 200 responses without throwing', () => {
    const source = new TestPollingSource();
    const warn = vi.fn();
    source.setWarnForTest(warn);

    const result = source.validate(
      { status: 200, data: { id: 'bad' }, etag: 'etag' },
      z.object({ id: z.number() }),
    );

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('bad payload', {
      data: expect.any(z.ZodError),
    });
  });
});

describe('PollingSourceBase lifetime', () => {
  it.live('drains admitted delivery after the last listener unbinds', () =>
    Effect.gen(function* () {
      const lifecycle = createLifecycleHost();
      const source = new TestPollingSource();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(release, undefined).pipe(
          Effect.andThen(lifecycle.runShutdown),
        ),
      );

      const disposable = yield* source
        .subscribeForTest(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(
          Effect.provideService(Lifecycle, lifecycle),
          Effect.provideService(Secrets, new FakeSecrets()),
        );

      yield* source.emitForTest('event');
      yield* Deferred.await(started);
      disposable.dispose();
      expect(source.activeKeys()).toEqual([]);

      const shutdown = yield* Effect.forkChild(lifecycle.runShutdown);
      yield* Effect.yieldNow;
      expect(shutdown.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(shutdown);
    }),
  );

  it.live(
    'keeps a replacement lifecycle independent of a draining shutdown',
    () =>
      Effect.gen(function* () {
        const oldLifecycle = createLifecycleHost();
        const newLifecycle = createLifecycleHost();
        const source = new TestPollingSource();
        const emptied = Deferred.makeUnsafe<void>();
        const oldStarted = yield* Deferred.make<void>();
        const oldRelease = yield* Deferred.make<void>();
        const newStarted = yield* Deferred.make<void>();
        const newRelease = yield* Deferred.make<void>();
        const keysChanged = source.onKeysChanged((keys) => {
          if (keys.length === 0) Deferred.doneUnsafe(emptied, Effect.void);
        });
        yield* Effect.addFinalizer(() =>
          Effect.all([
            Deferred.succeed(oldRelease, undefined),
            Deferred.succeed(newRelease, undefined),
            oldLifecycle.runShutdown,
            newLifecycle.runShutdown,
            Effect.sync(() => keysChanged.dispose()),
          ]).pipe(Effect.asVoid),
        );

        yield* source
          .subscribeForTest(() =>
            Deferred.succeed(oldStarted, undefined).pipe(
              Effect.andThen(Deferred.await(oldRelease)),
            ),
          )
          .pipe(
            Effect.provideService(Lifecycle, oldLifecycle),
            Effect.provideService(Secrets, new FakeSecrets()),
          );
        yield* source.emitForTest('old');
        yield* Deferred.await(oldStarted);

        const oldShutdown = yield* Effect.forkChild(oldLifecycle.runShutdown);
        yield* Deferred.await(emptied);
        expect(oldShutdown.pollUnsafe()).toBeUndefined();

        yield* source
          .subscribeForTest(() =>
            Deferred.succeed(newStarted, undefined).pipe(
              Effect.andThen(Deferred.await(newRelease)),
            ),
          )
          .pipe(
            Effect.provideService(Lifecycle, newLifecycle),
            Effect.provideService(Secrets, new FakeSecrets()),
          );
        yield* source.emitForTest('new');
        yield* Deferred.await(newStarted);

        yield* Deferred.succeed(oldRelease, undefined);
        yield* Fiber.join(oldShutdown);
        const newShutdown = yield* Effect.forkChild(newLifecycle.runShutdown);
        yield* Effect.yieldNow;
        expect(newShutdown.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(newRelease, undefined);
        yield* Fiber.join(newShutdown);
      }),
  );
});
