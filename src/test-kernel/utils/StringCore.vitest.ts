import { describe, expect, it } from 'vitest';

import { formatCompactDuration } from '@utils/core/stringCore';

describe('formatCompactDuration', () => {
  it.each([
    [-500, '0s'],
    [0, '0s'],
    [999, '0s'],
    [1500, '1s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [185_000, '3m 5s'],
    [3_600_000, '1h'],
    [3_660_000, '1h 1m'],
    [90_000_000, '1d 1h'],
  ])('renders %i ms as %s', (ms, label) => {
    expect(formatCompactDuration(ms)).toBe(label);
  });
});
