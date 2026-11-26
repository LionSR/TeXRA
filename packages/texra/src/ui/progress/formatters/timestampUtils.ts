/**
 * Timestamp formatting utilities for progress view formatters.
 */

import { formatShortDateTime } from '@ui/formatting/dateTimeFormat';

/** A time of day to the second, as a stage or a background task prints it. */
export const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const TIME_OF_DAY_TO_MINUTE = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/** A row's time of day, and the full moment for its tooltip in the short
 *  date-time every host prints. */
export function formatDisplayTimestamp(
  date: Date,
  precision: 'minute' | 'second' = 'second',
): {
  timeDisplay: string;
  tooltipTimestamp: string;
} {
  return {
    timeDisplay: (precision === 'minute'
      ? TIME_OF_DAY_TO_MINUTE
      : TIME_OF_DAY
    ).format(date),
    tooltipTimestamp: formatShortDateTime(date) ?? '',
  };
}
