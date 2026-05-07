import { describe, expect, it } from 'vitest';

import { parseCriticismAnnotations } from '@latex/criticismParser';
import { AddCriticismInputSchema } from '@tools/AddCriticismTool';

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
});

describe('AddCriticismInputSchema', () => {
  it('rejects empty paths and accepts severity zero', () => {
    expect(() =>
      AddCriticismInputSchema.parse({
        path: '   ',
        line: 1,
        message: 'x',
        severity: 1,
        confidence: 5,
      }),
    ).toThrow();

    expect(
      AddCriticismInputSchema.parse({
        path: 'paper.tex',
        line: 1,
        message: 'verified',
        severity: 0,
        confidence: 5,
      }).severity,
    ).toBe(0);
  });
});
