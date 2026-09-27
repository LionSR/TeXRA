import { describe, expect, it } from 'vitest';

import { formatSubscriptionUsagePercent } from '@shared/subscriptionUsagePresentation';

describe('subscription usage percent formatting', () => {
  it.each([
    [99.95, '99.9%'],
    [0.05, '0.1%'],
    [100, '100%'],
    [0, '0%'],
  ] as const)('formats boundary usage %s as %s', (percent, expected) => {
    expect(formatSubscriptionUsagePercent(percent)).toBe(expected);
  });
});
