import { describe, expect, it } from 'vitest';

import {
  spendingQuotaRemainingPercent,
  spendingQuotaState,
  type SpendingStatus,
} from '@shared/schemas/spendingStatus';

function status(overrides: Partial<SpendingStatus> = {}): SpendingStatus {
  return {
    currentSpend: 0,
    limit: 10,
    remaining: 10,
    percentUsed: 0,
    ...overrides,
  };
}

describe('spendingQuotaState', () => {
  it.each([
    [0, 'ok'],
    [79.4, 'ok'],
    [80, 'warning'],
    [99.9, 'warning'],
  ] as const)('reports %s%% used as %s', (percentUsed, expected) => {
    expect(spendingQuotaState(status({ percentUsed, remaining: 1 }))).toBe(
      expected,
    );
  });

  it('treats no headroom as exhausted regardless of the reported percent', () => {
    expect(spendingQuotaState(status({ percentUsed: 12, remaining: 0 }))).toBe(
      'exhausted',
    );
  });
});

describe('spendingQuotaRemainingPercent', () => {
  it('rounds the headroom and never reports a negative remainder', () => {
    expect(spendingQuotaRemainingPercent(status({ percentUsed: 84.2 }))).toBe(
      16,
    );
    expect(spendingQuotaRemainingPercent(status({ percentUsed: 130 }))).toBe(0);
  });
});
