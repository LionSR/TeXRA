// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { findBraceBalancedMacroCalls } from '@utils/text/braceBalancedMacro';

describe('findBraceBalancedMacroCalls', () => {
  it('finds a single call and returns its args and span', () => {
    const source = 'before \\foo{a}{b} after';
    const calls = findBraceBalancedMacroCalls(source, '\\foo', 2);

    expect(calls).toEqual([{ args: ['a', 'b'], start: 7, end: 17 }]);
    expect(source.slice(calls[0]!.start, calls[0]!.end)).toBe('\\foo{a}{b}');
  });

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

  it('allows whitespace between the macro name and each argument', () => {
    const calls = findBraceBalancedMacroCalls('\\foo {a} {b}', '\\foo', 2);

    expect(calls).toEqual([{ args: ['a', 'b'], start: 0, end: 12 }]);
  });

  it('finds multiple calls in order', () => {
    const calls = findBraceBalancedMacroCalls(
      '\\foo{a}{b} text \\foo{c}{d}',
      '\\foo',
      2,
    );

    expect(calls.map((c) => c.args)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('skips a macro name that is a prefix of a longer identifier', () => {
    expect(findBraceBalancedMacroCalls('\\fooBar{a}{b}', '\\foo', 2)).toEqual(
      [],
    );
  });

  it('skips a call with fewer than argCount brace groups', () => {
    expect(findBraceBalancedMacroCalls('\\foo{a}', '\\foo', 2)).toEqual([]);
  });

  it('resumes scanning after a short match instead of stopping', () => {
    const calls = findBraceBalancedMacroCalls(
      '\\foo{a} \\foo{b}{c}',
      '\\foo',
      2,
    );

    expect(calls.map((c) => c.args)).toEqual([['b', 'c']]);
  });

  it('returns an empty array when the macro never appears', () => {
    expect(findBraceBalancedMacroCalls('no macro here', '\\foo', 2)).toEqual(
      [],
    );
  });
});
