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
});
