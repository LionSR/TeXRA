import { describe, expect, it } from 'vitest';

import { createBoundedIdSet } from '@progressView/frontend/utils/boundedIdSet';

describe('createBoundedIdSet', () => {
  it('refreshes recency on repeated add', () => {
    const ids = createBoundedIdSet(2);

    ids.add('a');
    ids.add('b');
    ids.add('a');
    ids.add('c');

    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
    expect(ids.has('c')).toBe(true);
  });
});
