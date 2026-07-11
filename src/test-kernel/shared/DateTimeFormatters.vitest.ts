import { describe, expect, it } from 'vitest';

import { formatShortDateTime, formatUpdatedDate } from '@shared/utils/string';

/**
 * History (HistoryItemElement) and Memory (MemoryItem) list items both show
 * an absolute "last touched" timestamp in their meta strip. The empty-states
 * consolidation converged both onto this one shaped formatter so the two
 * tabs render matching timestamp text instead of a bare `toLocaleString()`
 * on one side and a prefixed `Intl.DateTimeFormat` on the other.
 */
describe('formatShortDateTime / formatUpdatedDate', () => {
  const sample = new Date('2026-07-11T15:45:00.000Z');

  it('formats a bare short-month/no-seconds timestamp with no prefix', () => {
    const formatted = formatShortDateTime(sample);
    expect(formatted).not.toBeNull();
    expect(formatted).not.toContain('Updated');
    // Contains the year and short month regardless of locale/timezone.
    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/Jul/);
  });

  it('formatUpdatedDate wraps the same shaped text with an "Updated" prefix', () => {
    const bare = formatShortDateTime(sample);
    expect(formatUpdatedDate(sample)).toBe(`Updated ${bare}`);
  });

  it('returns null for missing/invalid input so callers can supply their own fallback', () => {
    expect(formatShortDateTime(null)).toBeNull();
    expect(formatShortDateTime(undefined)).toBeNull();
    expect(formatShortDateTime('not-a-date')).toBeNull();
  });

  it('formatUpdatedDate falls back to "Updated: unknown" for missing/invalid input', () => {
    expect(formatUpdatedDate(null)).toBe('Updated: unknown');
    expect(formatUpdatedDate('not-a-date')).toBe('Updated: unknown');
  });
});
