import { intlFormatDistance } from 'date-fns';
import prettyBytes from 'pretty-bytes';

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

export function formatUpdatedDate(
  value: string | number | Date | null | undefined,
): string {
  if (!value) return 'Updated: unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Updated: unknown';
  return `Updated ${DATE_TIME_FORMATTER.format(date)}`;
}

export function formatLineCount(count: number): string {
  return count === 1 ? '1 line' : `${count} lines`;
}

export function formatBytes(bytes: number): string {
  return prettyBytes(bytes, { binary: true });
}
