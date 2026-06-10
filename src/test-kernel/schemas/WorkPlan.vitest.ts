import { describe, expect, it } from 'vitest';

import { planSummaryLine } from '@shared/schemas/workPlan';

describe('work plan schema helpers', () => {
  it('returns a stable placeholder for whitespace-only objectives', () => {
    expect(planSummaryLine(' \n\t')).toBe('(empty plan)');
  });
});
