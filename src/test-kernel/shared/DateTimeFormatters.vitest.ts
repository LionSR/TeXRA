import { describe, expect, it } from 'vitest';

import { formatShortDateTime } from '@shared/utils/string';

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
