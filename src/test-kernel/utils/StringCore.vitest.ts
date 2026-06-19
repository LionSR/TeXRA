import { describe, expect, it } from 'vitest';

import {
  formatCompactDuration,
  formatCompactTokenCount,
} from '@utils/core/stringCore';

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

describe('formatCompactTokenCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [4096, '4096'],
    [4097, '4k'],
    [999_499, '999k'],
    [999_500, '1.0M'],
    [999_999, '1.0M'],
    [1_000_000, '1.0M'],
    [1_250_000, '1.3M'],
  ])('renders %i tokens as %s', (tokens, label) => {
    expect(formatCompactTokenCount(tokens)).toBe(label);
  });
});
