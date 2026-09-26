// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { describe, expect } from 'vitest';

import { Secrets } from '@platform/secrets';
import { FakeSecrets } from '@test/support/FakePlatform';
// Local imports - tools
import { getNewestTimestamp } from '@tools/github/githubPaths';
import { DedupedResource } from '@tools/github/pollingDedup';
import {
  PollingSourceBase,
  createBasePollState,
  makePollingLifetime,
  type BasePollSubscriptionState,
  type PollHookRejected,
  type PollingLifetime,
} from '@tools/github/PollingSourceBase';

interface TestItem {
  id: number;
  created_at: string;
  updated_at?: string | null;
}

class TestPollingSource extends PollingSourceBase<
  string,
  BasePollSubscriptionState
> {
  constructor(lifetime: PollingLifetime) {
    super(
      {
        name: 'TestPollingSource',
        pollIntervalMs: 10_000,
        maxConcurrent: 1,
        backoffBaseMs: 1_000,
        backoffMaxMs: 10_000,
        maxFailureDurationMs: 60_000,
      },
      lifetime,
    );
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

describe('PollingSourceBase lifetime', () => {
  it.live('drains admitted delivery after the last listener unbinds', () =>
    Effect.gen(function* () {
      // The owner's scope: closing it is the process shutdown the source's
      // lifetime belongs to.
      const owner = yield* Scope.make();
      const lifetime = yield* makePollingLifetime.pipe(
        Effect.provideService(Scope.Scope, owner),
      );
      const source = new TestPollingSource(lifetime);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(release, undefined).pipe(
          Effect.andThen(Scope.close(owner, Exit.void)),
        ),
      );

      const disposable = yield* source
        .subscribeForTest(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.provideService(Secrets, new FakeSecrets()));

      yield* source.emitForTest('event');
      yield* Deferred.await(started);
      disposable.dispose();
      expect(source.activeKeys()).toEqual([]);

      const shutdown = yield* Effect.forkChild(Scope.close(owner, Exit.void));
      yield* Effect.yieldNow;
      expect(shutdown.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(shutdown);
    }),
  );
});
