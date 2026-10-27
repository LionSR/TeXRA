/**
 * How a renderer words a size and a moment: English
 * copy every host prints the same way.
 */
import prettyBytes from 'pretty-bytes';

/** Human-readable byte size in binary units (`1.5 MiB`, `1023 B`). */
export function formatBytes(bytes: number): string {
  return prettyBytes(bytes, { binary: true });
}

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});
const DAY_MS = 86_400_000;
/** The mean Gregorian year, and a twelfth of it as the month. */
const YEAR_MS = 31_556_952_000;
const MONTH_MS = YEAR_MS / 12;

/**
 * Calendar-aware "X ago" / "in X" (`yesterday`, `last week`, `in 3 hours`),
 * the largest unit the distance fills: seconds, minutes and hours by elapsed
 * time, days and larger by local calendar boundaries, weeks starting Sunday.
 */
export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const format = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    relativeTimeFormat.format(value, unit);
  const then = new Date(timestamp);
  const now = new Date();
  const ms = timestamp - now.getTime();
  const abs = Math.abs(ms);
  const calendarDay = (d: Date) =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
  const days = calendarDay(then) - calendarDay(now);
  const years = then.getFullYear() - now.getFullYear();
  const quarters =
    years * 4 +
    Math.floor(then.getMonth() / 3) -
    Math.floor(now.getMonth() / 3);

  if (abs < 60_000) return format(Math.trunc(ms / 1000), 'second');
  if (abs < 3_600_000) return format(Math.trunc(ms / 60_000), 'minute');
  if (abs < DAY_MS && days === 0) {
    return format(Math.trunc(ms / 3_600_000), 'hour');
  }
  if (abs < 7 * DAY_MS && days !== 0 && Math.abs(days) < 7) {
    return format(days, 'day');
  }
  if (abs < MONTH_MS) {
    return format((days - then.getDay() + now.getDay()) / 7, 'week');
  }
  if (abs < 3 * MONTH_MS) {
    return format(years * 12 + then.getMonth() - now.getMonth(), 'month');
  }
  if (abs < YEAR_MS && quarters < 4) return format(quarters, 'quarter');
  return format(years, 'year');
}
