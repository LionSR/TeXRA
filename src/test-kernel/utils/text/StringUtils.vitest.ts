// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  formatTimestamp,
  formatRelativeTime,
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

describe('formatResultCount', () => {
  it('formats singular and library-backed plural counts', () => {
    expect(formatResultCount(1, 'entry')).toBe('1 entry');
    expect(formatResultCount(2, 'entry')).toBe('2 entries');
  });

  it('honors explicit invariant plurals', () => {
    expect(formatResultCount(2, 'info', 'info')).toBe('2 info');
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

describe('formatCompactDuration', () => {
  it.each([
    [-500, '0s'],
    [0, '0s'],
    [999, '0s'],
    [1500, '1s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [185_000, '3m 5s'],
    [3_600_000, '1h'],
    [3_660_000, '1h 1m'],
    [90_000_000, '1d 1h'],
  ])('renders %i ms as %s', (ms, label) => {
    expect(formatCompactDuration(ms)).toBe(label);
  });
});

describe('formatCompactTokenCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [4096, '4096'],
    [4097, '4k'],
    [999_499, '999k'],
    [999_500, '1.0M'],
    [999_999, '1.0M'],
    [1_000_000, '1.0M'],
    [1_250_000, '1.3M'],
  ])('renders %i tokens as %s', (tokens, label) => {
    expect(formatCompactTokenCount(tokens)).toBe(label);
  });
});

describe('formatTimestamp', () => {
  it('normalizes offset timestamps to compact UTC', () => {
    expect(formatTimestamp('2026-06-02T16:30:45.123+02:00')).toBe(
      '2026-06-02 14:30:45',
    );
  });

  it('keeps invalid timestamps non-throwing', () => {
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('abcTdef')).toBe('abc def');
  });
});

describe('formatRelativeTime', () => {
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const hour = 3_600_000;
  const day = 24 * hour;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    [0, 0, 'second'],
    [59_000, 59, 'second'],
    [60_000, 1, 'minute'],
    [59 * 60_000, 59, 'minute'],
    [hour, 1, 'hour'],
    [23 * hour, 23, 'hour'],
    [day, 1, 'day'],
    [7 * day, 1, 'week'],
    [8 * day, 1, 'week'],
    [30 * day, 4, 'week'],
    [31 * day, 1, 'month'],
    [90 * day, 3, 'month'],
    [92 * day, 1, 'quarter'],
    [364 * day, 3, 'quarter'],
  ] as const)(
    'uses the prior duration ladder for a %i ms future timestamp',
    (offset, value, unit) => {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 30));
      expect(formatRelativeTime(Date.now() + offset)).toBe(
        formatter.format(value, unit),
      );
    },
  );

  it.each([
    [-59_000, -59, 'second'],
    [-60_000, -1, 'minute'],
    [-hour, -1, 'hour'],
    [-day, -1, 'day'],
    [-7 * day, -1, 'week'],
    [-30 * day, -4, 'week'],
    [-90 * day, -3, 'month'],
    [-364 * day, -4, 'quarter'],
  ] as const)(
    'uses the prior duration ladder for a %i ms past timestamp',
    (offset, value, unit) => {
      vi.setSystemTime(new Date(2026, 0, 1, 23, 30));
      expect(formatRelativeTime(Date.now() + offset)).toBe(
        formatter.format(value, unit),
      );
    },
  );

  it.each([
    [366 * day, 1],
    [-366 * day, -1],
  ] as const)(
    'uses calendar years beyond the quarter threshold (%i ms)',
    (offset, value) => {
      vi.setSystemTime(new Date(2026, 6, 1, 12));
      expect(formatRelativeTime(Date.now() + offset)).toBe(
        formatter.format(value, 'year'),
      );
    },
  );
});

// Shared "last touched" timestamp formatter for History and Memory list items.
describe('formatShortDateTime', () => {
  const sample = new Date('2026-07-11T15:45:00.000Z');

  it('formats a bare short-month/no-seconds timestamp with no prefix', () => {
    const formatted = formatShortDateTime(sample);
    expect(formatted).not.toBeNull();
    expect(formatted).not.toContain('Updated');
    // Contains the year and short month. Derive the expected month token
    // from the same locale-aware Intl.DateTimeFormat shape rather than
    // hard-coding an English name, so the assertion holds under any
    // process locale (e.g. LC_ALL=fr_FR / de_DE in CI).
    const expectedMonth = new Intl.DateTimeFormat(undefined, {
      month: 'short',
    }).format(sample);
    expect(formatted).toContain('2026');
    expect(formatted).toContain(expectedMonth);
  });

  it('returns null for missing/invalid input so callers can supply their own fallback', () => {
    expect(formatShortDateTime(null)).toBeNull();
    expect(formatShortDateTime(undefined)).toBeNull();
    expect(formatShortDateTime('not-a-date')).toBeNull();
  });
});
