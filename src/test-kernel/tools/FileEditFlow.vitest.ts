import { describe, expect, it } from 'vitest';

import { ToolError } from '@shared/schemas';
import {
  findOccurrenceLineNumbers,
  replaceAllLiteral,
  replaceFirstLiteral,
  replaceLiteralMatches,
} from '@tools/fileEditFlow';
import { ViewRangeSchema } from '@tools/formatting';

describe('literal replacement primitives', () => {
  // String.prototype.replace interprets these as replacement patterns; the
  // primitives must insert them verbatim for LaTeX and code edits.
  const dollarPatterns = [
    '$&',
    "$'",
    '$`',
    '$$',
    '$1',
    'a$&b$$c',
    '\\sum_{i=1}^{n} $x_i$',
  ] as const;

  it.each(dollarPatterns)(
    'replaceFirstLiteral inserts %j verbatim',
    (replacement) => {
      expect(replaceFirstLiteral('before OLD after', 'OLD', replacement)).toBe(
        `before ${replacement} after`,
      );
    },
  );

  it.each(dollarPatterns)(
    'replaceAllLiteral inserts %j verbatim for every occurrence',
    (replacement) => {
      expect(replaceAllLiteral('OLD and OLD', 'OLD', replacement)).toBe(
        `${replacement} and ${replacement}`,
      );
    },
  );

  it('replaces only the first literal occurrence', () => {
    expect(replaceFirstLiteral('x OLD y OLD z', 'OLD', 'NEW')).toBe(
      'x NEW y OLD z',
    );
  });

  it('returns content unchanged when the first-match needle is absent', () => {
    expect(replaceFirstLiteral('nothing here', 'OLD', 'NEW')).toBe(
      'nothing here',
    );
  });

  it('rejects empty search strings', () => {
    expect(() => replaceFirstLiteral('abc', '', 'x')).toThrow(ToolError);
    expect(() => replaceAllLiteral('abc', '', 'x')).toThrow(ToolError);
  });

  it('reports every 1-indexed matching line', () => {
    expect(
      findOccurrenceLineNumbers('foo\nbar foo\nbaz\nfoo again', 'foo'),
    ).toEqual([1, 2, 4]);
  });

  it('reports no lines for absent or empty needles', () => {
    expect(findOccurrenceLineNumbers('a\nb\nc', 'zzz')).toEqual([]);
    expect(findOccurrenceLineNumbers('a\nb\nc', '')).toEqual([]);
  });
});

describe('replaceLiteralMatches', () => {
  const notFoundError = () => 'missing';

  it('returns the unique replacement and its 1-based line', () => {
    expect(
      replaceLiteralMatches({
        content: 'alpha\nbeta\ngamma',
        search: 'beta',
        replacement: 'delta',
        mode: 'unique',
        notFoundError,
      }),
    ).toEqual({
      content: 'alpha\ndelta\ngamma',
      count: 1,
      firstMatchLine: 2,
      lineNumbers: [2],
    });
  });

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

  it('replaces every literal match without interpreting dollar patterns', () => {
    expect(
      replaceLiteralMatches({
        content: 'OLD and OLD',
        search: 'OLD',
        replacement: '$&',
        mode: 'all',
        notFoundError,
      }),
    ).toEqual({
      content: '$& and $&',
      count: 2,
      firstMatchLine: 1,
      lineNumbers: [1],
    });
  });

  it('reports the exact first line of a multi-line match', () => {
    expect(
      replaceLiteralMatches({
        content: 'header\nfirst\nsecond\nfooter',
        search: 'first\nsecond',
        replacement: 'joined',
        mode: 'unique',
        notFoundError,
      }).firstMatchLine,
    ).toBe(2);
  });
});

describe('ViewRangeSchema', () => {
  it('accepts an inclusive 1-based range', () => {
    expect(ViewRangeSchema.parse([2, 5])).toEqual([2, 5]);
  });

  it.each([
    [0, 1],
    [2, 1],
    [1, 1.5],
  ])('rejects invalid range %j', (range) => {
    expect(ViewRangeSchema.safeParse(range).success).toBe(false);
  });
});
