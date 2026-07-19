// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - edit primitives under test
import { ToolError } from '@shared/schemas/toolResult';
import {
  findOccurrenceLineNumbers,
  replaceAllLiteral,
  replaceFirstLiteral,
} from '@tools/fileEditFlow';

describe('fileEditFlow literal replacement', () => {
  // Regression: String.prototype.replace interprets $$, $&, $', `$\`` and
  // $<name> in the replacement string, silently corrupting LaTeX/code edits.
  // The primitives must insert the replacement verbatim.
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

  it('replaceFirstLiteral only replaces the first occurrence', () => {
    expect(replaceFirstLiteral('x OLD y OLD z', 'OLD', 'NEW')).toBe(
      'x NEW y OLD z',
    );
  });

  it('replaceFirstLiteral returns content unchanged when needle is absent', () => {
    expect(replaceFirstLiteral('nothing here', 'OLD', 'NEW')).toBe(
      'nothing here',
    );
  });

  it('replaceFirstLiteral rejects an empty search string', () => {
    expect(() => replaceFirstLiteral('abc', '', 'x')).toThrow(ToolError);
  });

  it('replaceAllLiteral rejects an empty search string', () => {
    expect(() => replaceAllLiteral('abc', '', 'x')).toThrow(ToolError);
  });
});

describe('findOccurrenceLineNumbers', () => {
  it('returns 1-indexed line numbers of every matching line', () => {
    const content = 'foo\nbar foo\nbaz\nfoo again';
    expect(findOccurrenceLineNumbers(content, 'foo')).toEqual([1, 2, 4]);
  });

  it('returns an empty array when the needle is absent', () => {
    expect(findOccurrenceLineNumbers('a\nb\nc', 'zzz')).toEqual([]);
  });

  it('returns an empty array for an empty needle', () => {
    expect(findOccurrenceLineNumbers('a\nb\nc', '')).toEqual([]);
  });
});
