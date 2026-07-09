import { describe, expect, it } from 'vitest';

import {
  computeLocDelta,
  countLines,
} from '../../../scripts/check-test-loc-growth.mjs';

describe('check-test-loc-growth countLines', () => {
  it('counts lines for content with a trailing newline', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts lines for content without a trailing newline', () => {
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('returns 0 for empty content', () => {
    expect(countLines('')).toBe(0);
  });

  it('counts a single line with no newline as 1', () => {
    expect(countLines('a')).toBe(1);
  });
});

describe('check-test-loc-growth computeLocDelta', () => {
  it('reports a positive delta when current exceeds baseline', () => {
    expect(computeLocDelta(150, 100)).toEqual({
      current: 150,
      baseline: 100,
      delta: 50,
    });
  });

  it('reports a negative delta when current is below baseline', () => {
    expect(computeLocDelta(80, 100)).toEqual({
      current: 80,
      baseline: 100,
      delta: -20,
    });
  });

  it('reports a zero delta when current equals baseline', () => {
    expect(computeLocDelta(100, 100)).toEqual({
      current: 100,
      baseline: 100,
      delta: 0,
    });
  });
});
