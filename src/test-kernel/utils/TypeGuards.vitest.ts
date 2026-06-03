import { describe, expect, it } from 'vitest';

import { filterNotNull, filterNotNullish } from '@utils/core';

describe('core type guard predicates', () => {
  it('filters null values as an Array.filter predicate', () => {
    const values: Array<string | null> = ['alpha', null, 'beta'];

    expect(values.filter(filterNotNull)).toEqual(['alpha', 'beta']);
  });

  it('filters nullish values as an Array.filter predicate', () => {
    const values: Array<string | null | undefined> = [
      'alpha',
      null,
      undefined,
      'beta',
    ];

    expect(values.filter(filterNotNullish)).toEqual(['alpha', 'beta']);
  });
});
