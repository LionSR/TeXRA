import { Result } from 'effect';
import { describe, expect, it } from 'vitest';

import { replaceLiteralMatches } from '@tools/fileEditFlow';

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

  it('inserts replacement patterns verbatim for a unique match', () => {
    for (const replacement of dollarPatterns) {
      expect(
        replaceLiteralMatches({
          content: 'before OLD after',
          search: 'OLD',
          replacement,
          mode: 'unique',
          notFoundError,
        }),
      ).toEqual(
        Result.succeed({ content: `before ${replacement} after`, count: 1 }),
      );
    }
  });

  it('inserts replacement patterns verbatim for every occurrence', () => {
    for (const replacement of dollarPatterns) {
      expect(
        replaceLiteralMatches({
          content: 'OLD and OLD',
          search: 'OLD',
          replacement,
          mode: 'all',
          notFoundError,
        }),
      ).toEqual(
        Result.succeed({
          content: `${replacement} and ${replacement}`,
          count: 2,
        }),
      );
    }
  });
});
