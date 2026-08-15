import { describe, expect, it } from 'vitest';

import { KVStoreCache } from '@common/storage/KVStoreCache';
import { KVStore } from '@common/storage/KVStore';

describe('KVStoreCache', () => {
  const create = () => new KVStore('/tmp/unused');

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    2 ** 32 - 1,
    2 ** 32,
  ])('throws the KVStoreCache RangeError for max=%s', (max) => {
    let caught: unknown;
    try {
      new KVStoreCache(create, { max });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toMatch(
      /^KVStoreCache max must be a positive safe integer/,
    );
  });

  it('keeps every cached handle when max is unset (unbounded)', () => {
    const cache = new KVStoreCache(create);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const handles = ids.map((id) => cache.get(id));
    for (const [index, id] of ids.entries()) {
      expect(cache.get(id)).toBe(handles[index]);
    }
  });

  it('evicts the least-recently-used handle once max is exceeded', () => {
    const cache = new KVStoreCache(create, { max: 2 });
    const a = cache.get('a');
    const b = cache.get('b');
    // Refresh `a` so `b`, not `a`, is now the least-recently-used handle.
    expect(cache.get('a')).toBe(a);
    const c = cache.get('c');
    expect(cache.get('c')).toBe(c);
    expect(cache.get('a')).toBe(a);
    expect(cache.get('b')).not.toBe(b);
  });
});
