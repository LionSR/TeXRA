import { describe, expect, it } from 'vitest';

import { KVStoreCache } from '@common/storage/KVStoreCache';
import { KVStore } from '@common/storage/KVStore';

describe('KVStoreCache max validation', () => {
  const create = () => new KVStore('/tmp/unused');

  it.each([0, -1, 1.5, Number.NaN])('throws RangeError for max=%s', (max) => {
    expect(() => new KVStoreCache(create, { max })).toThrow(RangeError);
  });

  it('accepts an unset max as unbounded', () => {
    const cache = new KVStoreCache(create);
    expect(cache.get('a')).toBe(cache.get('a'));
  });

  it('accepts a positive integer max', () => {
    const cache = new KVStoreCache(create, { max: 2 });
    expect(cache.get('a')).toBe(cache.get('a'));
  });
});
