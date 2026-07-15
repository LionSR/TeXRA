import { intlFormatDistance } from 'date-fns';
import prettyBytes from 'pretty-bytes';

import { formatResultCount } from '@utils/text/stringUtils';

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Calendar-aware "X ago" / "in X" via Intl.RelativeTimeFormat (handles future timestamps too). */
export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  return intlFormatDistance(timestamp, Date.now());
}

/**
 * Formats a date-parsable value as a compact, locale-aware absolute
 * timestamp (short month, no seconds) — the shared "list-item timestamp"
 * shape used across the settingsView History and Memory lists. Returns
 * `null` for missing/invalid input so callers can supply their own fallback
 * copy (e.g. `formatUpdatedDate`'s "Updated: unknown").
 */
export function formatShortDateTime(
  value: string | number | Date | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return DATE_TIME_FORMATTER.format(date);
}

export function formatUpdatedDate(
  value: string | number | Date | null | undefined,
): string {
  const formatted = formatShortDateTime(value);
  return formatted ? `Updated ${formatted}` : 'Updated: unknown';
}

export function formatLineCount(count: number): string {
  return formatResultCount(count, 'line');
}

export function formatBytes(bytes: number): string {
  return prettyBytes(bytes, { binary: true });
}
