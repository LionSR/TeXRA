import { describe, expect, it } from 'vitest';

import { AnnotationFetchBudget } from '@tools/github/annotationFetchBudget';

describe('AnnotationFetchBudget', () => {
  it('does not stall refills after the clock moves backward', () => {
    const budget = new AnnotationFetchBudget(1, 1000);
    budget.resetForTests(1, 1000);

    expect(budget.tryClaim(1000)).toBe(true);
    expect(budget.tryClaim(900)).toBe(false);
    expect(budget.tryClaim(1900)).toBe(true);
  });
});
