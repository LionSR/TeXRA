import { describe, expect, it } from 'vitest';

import { ToolError } from '@shared/schemas';
import { replaceLiteralMatches } from '@tools/fileEditFlow';
import { ViewRangeSchema } from '@tools/formatting';

describe('replaceLiteralMatches', () => {
  const notFoundError = () => 'missing';

  // String.prototype.replace interprets these as replacement patterns; the
  // replacement must insert them verbatim for LaTeX and code edits.
  const dollarPatterns = [
    '$&',
    "$'",
    '$`',
    '$$',
    '$1',
    'a$&b$$c',
    '\\sum_{i=1}^{n} $x_i$',
  ] as const;

  it('throws the not-found error for absent and empty needles', () => {
    const request = {
      content: 'alpha',
      replacement: 'delta',
      mode: 'unique',
      notFoundError,
    } as const;
    expect(() => replaceLiteralMatches({ ...request, search: 'zzz' })).toThrow(
      new ToolError('missing'),
    );
    expect(() => replaceLiteralMatches({ ...request, search: '' })).toThrow(
      new ToolError('missing'),
    );
  });

  it.each(dollarPatterns)(
    'inserts %j verbatim for a unique match',
    (replacement) => {
      expect(
        replaceLiteralMatches({
          content: 'before OLD after',
          search: 'OLD',
          replacement,
          mode: 'unique',
          notFoundError,
        }).content,
      ).toBe(`before ${replacement} after`);
    },
  );

  it('reports every matching line through the declared ambiguity error', () => {
    expect(() =>
      replaceLiteralMatches({
        content: 'same\nother same\nsame',
        search: 'same',
        replacement: 'new',
        mode: 'unique',
        notFoundError,
        multipleMatchesError: ({ count, lineNumbers }) =>
          `${count} matches on ${lineNumbers.join(',')}`,
      }),
    ).toThrow(new ToolError('3 matches on 1,2,3'));
  });

  it.each(dollarPatterns)(
    'inserts %j verbatim for every occurrence',
    (replacement) => {
      expect(
        replaceLiteralMatches({
          content: 'OLD and OLD',
          search: 'OLD',
          replacement,
          mode: 'all',
          notFoundError,
        }),
      ).toEqual({ content: `${replacement} and ${replacement}`, count: 2 });
    },
  );
});
