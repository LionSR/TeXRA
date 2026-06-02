import prettyBytes from 'pretty-bytes';

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return RELATIVE_TIME_FORMATTER.format(-diffMin, 'minute');
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return RELATIVE_TIME_FORMATTER.format(-diffHr, 'hour');
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return RELATIVE_TIME_FORMATTER.format(-diffDay, 'day');
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12)
    return RELATIVE_TIME_FORMATTER.format(-diffMonth, 'month');
  return RELATIVE_TIME_FORMATTER.format(-Math.floor(diffMonth / 12), 'year');
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
