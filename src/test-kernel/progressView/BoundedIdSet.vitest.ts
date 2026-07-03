import { describe, expect, it } from 'vitest';

import { createBoundedIdSet } from '@progressView/frontend/utils/boundedIdSet';

describe('createBoundedIdSet', () => {
  it('evicts by first insertion, not by repeated add recency', () => {
    const ids = createBoundedIdSet(2);

    ids.add('a');
    ids.add('b');
    ids.add('a');
    ids.add('c');

    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });
});
