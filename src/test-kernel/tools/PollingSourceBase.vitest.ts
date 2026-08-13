// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { z, type ZodType } from 'zod';

// Local imports - tools
import { getNewestTimestamp } from '@tools/github/githubPaths';
import {
  DedupedResource,
  PollingSourceBase,
  type BasePollSubscriptionState,
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

  protected pollOne(): Promise<void> {
    return Promise.resolve();
  }

  protected formatErrorEvent(): string {
    return 'subscription error';
  }

  protected emitKeysChangedEvent(): void {
    // No-op: this test double doesn't need key-change events.
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

  it('keeps an existing cursor when seeding an empty list', () => {
    const resource = new DedupedResource<TestItem>({
      getId: (item) => item.id,
      getCursor: getNewestTimestamp,
      maxSeenIds: 3,
      sinceCursor: '2026-07-04T00:00:00Z',
    });

    resource.seed([]);

    expect(resource.sinceCursor).toBe('2026-07-04T00:00:00Z');
  });
});

describe('PollingSourceBase.validateOrSkip', () => {
  it('returns parsed 200 responses and passes through 304 responses', () => {
    const source = new TestPollingSource();
    const schema = z.object({ id: z.number() });

    expect(
      source.validate({ status: 200, data: { id: 7 }, etag: 'etag' }, schema),
    ).toEqual({ status: 200, data: { id: 7 }, etag: 'etag' });

    expect(source.validate({ status: 304 }, schema)).toEqual({ status: 304 });
  });

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
