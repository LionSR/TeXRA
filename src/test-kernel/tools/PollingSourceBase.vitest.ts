// Third-party imports
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

// Local imports - tools
import { DedupedResource } from '@texra/tools/github/pollingDedup';

interface TestItem {
  id: number;
  created_at: string;
  updated_at?: string | null;
}

describe('DedupedResource', () => {
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
