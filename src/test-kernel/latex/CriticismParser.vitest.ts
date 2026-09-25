import { describe, expect, it } from 'vitest';

import { parseCriticismAnnotations } from '@latex/criticismParser';

describe('parseCriticismAnnotations', () => {
  it('accepts whitespace before arguments and severity zero', () => {
    const annotations = parseCriticismAnnotations(
      'before\n\\criticize {verified \\textbf{step}} {0} {5}\nafter',
    );

    expect(annotations).toMatchObject([
      {
        message: 'verified \\textbf{step}',
        severity: 0,
        confidence: 5,
        line: 1,
        column: 0,
      },
    ]);
  });

  it('rejects non-integer and out-of-range confidence values', () => {
    expect(parseCriticismAnnotations('\\criticize{bad}{3}{999}')).toEqual([]);
    expect(parseCriticismAnnotations('\\criticize{bad}{3}{4.5}')).toEqual([]);
  });

  it('does not parse partial macro names', () => {
    expect(parseCriticismAnnotations('\\criticizeFoo{x}{3}{5}')).toEqual([]);
  });

  it('handles doubly-nested braces in the message argument', () => {
    const annotations = parseCriticismAnnotations(
      '\\criticize{see \\sqrt{\\frac{a}{b}}}{2}{3}',
    );

    expect(annotations).toMatchObject([
      {
        message: 'see \\sqrt{\\frac{a}{b}}',
        severity: 2,
        confidence: 3,
      },
    ]);
  });
});
