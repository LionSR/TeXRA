/**
 * Timestamp formatting utilities for progress view formatters.
 */

import {
  cachedDateTimeFormat,
  formatShortDateTime,
} from '@ui/formatting/dateTimeFormat';

const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

export function getTimeFormatter(): Intl.DateTimeFormat {
  return cachedDateTimeFormat(TIME_FORMAT_OPTIONS);
}

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
    timeDisplay:
      precision === 'minute'
        ? cachedDateTimeFormat({ hour: 'numeric', minute: '2-digit' }).format(
            date,
          )
        : getTimeFormatter().format(date),
    tooltipTimestamp: formatShortDateTime(date) ?? '',
  };
}
