/**
 * Timestamp formatting utilities for progress view formatters.
 */

// Local imports - formatter constants
import { DATETIME_FORMAT_OPTIONS, TIME_FORMAT_OPTIONS } from './constants';

// Shared formatters (lazily initialized for browser environments)
let TIME_FORMATTER: Intl.DateTimeFormat | null = null;
let DATE_TIME_FORMATTER: Intl.DateTimeFormat | null = null;

/** Get the time-only formatter. */
export function getTimeFormatter(): Intl.DateTimeFormat {
  TIME_FORMATTER ??= new Intl.DateTimeFormat(undefined, TIME_FORMAT_OPTIONS);
  return TIME_FORMATTER;
}

/** Get the date-time formatter. */
function getDateTimeFormatter(): Intl.DateTimeFormat {
  DATE_TIME_FORMATTER ??= new Intl.DateTimeFormat(
    undefined,
    DATETIME_FORMAT_OPTIONS,
  );
  return DATE_TIME_FORMATTER;
}

/** Format a timestamp for display. */
export function formatDisplayTimestamp(date: Date): {
  fullTimestamp: string;
  timeDisplay: string;
  tooltipTimestamp: string;
} {
  return {
    fullTimestamp: date.toISOString(),
    timeDisplay: getTimeFormatter().format(date),
    tooltipTimestamp: getDateTimeFormatter().format(date),
  };
}
