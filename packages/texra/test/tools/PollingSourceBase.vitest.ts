// Third-party imports
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

// Local imports - tools
import { readNewItems } from '@texra/tools/github/poller';

/** The id history's capacity in `readNewItems`. */
const CAPACITY = 1000;

const item = (id: number) => ({
  id,
  user: null,
  created_at: '2026-07-04T00:00:00Z',
});

describe('readNewItems', () => {
  it('does not re-emit an already-seen id evicted mid-batch by later new ids', () => {
    // Regression: the seen ids are an LRU cache that can evict as soon as a
    // `set()` pushes it over cap, instead of trimming once after the whole
    // batch. If the classification re-checked `has()` against that
    // continuously-evicting cache, a batch fetched sort=updated&direction=asc
    // (GitHub's poll order) where enough brand-new items push a previously
    // seen id out of the cache before the loop reaches that id's own
    // (edited) occurrence later in the same page would treat it as new and
    // re-emit it.
    const { seen } = readNewItems(undefined, {
      status: 200,
      data: [item(0)],
      etag: undefined,
    });
    const newer = Array.from({ length: CAPACITY }, (_, index) =>
      item(index + 1),
    );
    const { fresh } = readNewItems(seen, {
      status: 200,
      // Edited older comment: same id already seen in the prior tick, but
      // resorts to the end of this ascending-by-updated_at page.
      data: [...newer, item(0)],
      etag: undefined,
    });

    expect(fresh.map((entry) => entry.id)).toEqual(
      newer.map((entry) => entry.id),
    );
  });
});
