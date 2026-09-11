// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  formatTimestamp,
  formatCompactDuration,
  formatCompactTokenCount,
  formatResultCount,
  formatShortDateTime,
  pluralize,
  splitContentLines,
  splitOutputLines,
  tailWithEllipsis,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

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

describe('formatTimestamp', () => {
  it('normalizes offset timestamps to compact UTC', () => {
    expect(formatTimestamp('2026-06-02T16:30:45.123+02:00')).toBe(
      '2026-06-02 14:30:45',
    );
  });
});

// Shared "last touched" timestamp formatter for History and Memory list items.
