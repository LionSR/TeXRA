// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  pluralize,
  splitContentLines,
  splitOutputLines,
  tailWithEllipsis,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

describe('splitContentLines', () => {
  it('normalizes CRLF and drops the phantom line after a trailing newline', () => {
    const lines = splitContentLines('a\r\nb\r\nc\r\n');

    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('splits content without a trailing newline', () => {
    expect(splitContentLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('returns no lines for empty input', () => {
    expect(splitContentLines('')).toEqual([]);
  });
});

describe('splitOutputLines', () => {
  it('splits Unix-newline output and drops the trailing blank', () => {
    expect(splitOutputLines('foo\nbar\n')).toEqual(['foo', 'bar']);
  });

  it('normalizes CRLF before splitting', () => {
    expect(splitOutputLines('foo\r\nbar\r\n')).toEqual(['foo', 'bar']);
  });

  it('drops interior blank lines', () => {
    expect(splitOutputLines('foo\n\nbar')).toEqual(['foo', 'bar']);
  });

  it('returns an empty array for empty input', () => {
    expect(splitOutputLines('')).toEqual([]);
  });

  it('returns an empty array for a blank-only string', () => {
    expect(splitOutputLines('\n\n')).toEqual([]);
  });
});

describe('pluralize', () => {
  it('uses the singular form for one item', () => {
    expect(pluralize(1, 'entry')).toBe('entry');
  });

  it('uses library-backed pluralization when no override is provided', () => {
    expect(pluralize(2, 'entry')).toBe('entries');
  });

  it('honors explicit plural overrides', () => {
    expect(pluralize(2, 'person', 'people')).toBe('people');
  });
});

describe('Unicode-safe ellipsis helpers', () => {
  // Family emoji: U+1F468 ZWJ U+1F469 ZWJ U+1F467 — five code points, but one
  // grapheme cluster. The previous [...text] code-point counting would tear it;
  // Intl.Segmenter keeps it whole.
  const family = '👨‍👩‍👧';

  it('returns the original string when it fits within the limit', () => {
    expect(truncateWithEllipsis('abc', 5)).toBe('abc');
    expect(truncateWithEllipsis('abc', 3)).toBe('abc');
    expect(tailWithEllipsis('abc', 5)).toBe('abc');
  });

  it('does not split a surrogate pair at the trailing truncation boundary', () => {
    expect(truncateWithEllipsis('abc🍕def', 5)).toBe('abc🍕…');
  });

  it('does not split a surrogate pair at the leading truncation boundary', () => {
    expect(tailWithEllipsis('abc🍕def', 5)).toBe('…🍕def');
  });

  it('counts a ZWJ emoji sequence as a single grapheme when truncating', () => {
    // ['a', 'b', family, 'c', 'd'] -> keep first 3 graphemes + ellipsis
    expect(truncateWithEllipsis(`ab${family}cd`, 4)).toBe(`ab${family}…`);
    // keep last 3 graphemes + leading ellipsis
    expect(tailWithEllipsis(`ab${family}cd`, 4)).toBe(`…${family}cd`);
  });

  it('does not tear a combining diacritic from its base character', () => {
    // 'e' + combining acute accent is one grapheme cluster (two code points).
    expect(truncateWithEllipsis('éxyz', 2)).toBe('é…');
    expect(tailWithEllipsis('wxé', 2)).toBe('…é');
  });

  it('collapses to a bare ellipsis when the budget is one or less', () => {
    expect(truncateWithEllipsis('abcdef', 1)).toBe('…');
    expect(truncateWithEllipsis('abcdef', 0)).toBe('…');
    // Regression guard: slice(-(1-1)) === slice(0) once returned the whole tail.
    expect(tailWithEllipsis('abcdef', 1)).toBe('…');
    expect(tailWithEllipsis('abcdef', 0)).toBe('…');
  });
});
