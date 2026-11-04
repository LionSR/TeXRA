import { describe, expect, it } from 'vitest';

import { findBraceBalancedMacroCalls } from '@texra/utils/text/braceBalancedMacro';

describe('findBraceBalancedMacroCalls', () => {
  it('handles arbitrarily nested braces within an argument', () => {
    const calls = findBraceBalancedMacroCalls(
      '\\foo{\\sqrt{\\frac{a}{b}}}{2}',
      '\\foo',
      2,
    );

    expect(calls).toEqual([
      { args: ['\\sqrt{\\frac{a}{b}}', '2'], start: 0, end: 27 },
    ]);
  });
});
