/**
 * Timestamp formatting utilities for progress view formatters.
 */

// DateTimeFormat options for consistent timestamp formatting
const DATETIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

// Shared formatters (lazily initialized for browser environments)
let TIME_FORMATTER: Intl.DateTimeFormat | null = null;
let DATE_TIME_FORMATTER: Intl.DateTimeFormat | null = null;

/** Get the time-only formatter. */
export function getTimeFormatter(): Intl.DateTimeFormat {
  TIME_FORMATTER ??= new Intl.DateTimeFormat(undefined, TIME_FORMAT_OPTIONS);
  return TIME_FORMATTER;
}

/** Format a timestamp for display. */
export function formatDisplayTimestamp(date: Date): {
  timeDisplay: string;
  tooltipTimestamp: string;
} {
  DATE_TIME_FORMATTER ??= new Intl.DateTimeFormat(
    undefined,
    DATETIME_FORMAT_OPTIONS,
  );
  return {
    timeDisplay: getTimeFormatter().format(date),
    tooltipTimestamp: DATE_TIME_FORMATTER.format(date),
  };
}
