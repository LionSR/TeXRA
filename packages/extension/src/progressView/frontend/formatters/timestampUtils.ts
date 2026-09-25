/**
 * Timestamp formatting utilities for progress view formatters.
 */

import { cachedDateTimeFormat } from '@ui/formatting/dateTimeFormat';

const DATETIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/** Get the time-only formatter. */
export function getTimeFormatter(): Intl.DateTimeFormat {
  return cachedDateTimeFormat(TIME_FORMAT_OPTIONS);
}

/** Format a timestamp for display. */
export function formatDisplayTimestamp(date: Date): {
  timeDisplay: string;
  tooltipTimestamp: string;
} {
  return {
    timeDisplay: getTimeFormatter().format(date),
    tooltipTimestamp: cachedDateTimeFormat(DATETIME_FORMAT_OPTIONS).format(
      date,
    ),
  };
}
