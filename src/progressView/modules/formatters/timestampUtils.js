/**
 * Timestamp formatting utilities for progress view formatters.
 */

import { DATETIME_FORMAT_OPTIONS, TIME_FORMAT_OPTIONS } from './constants.js';

// Shared formatters (lazily initialized for browser environments)
let TIME_FORMATTER;
let DATE_TIME_FORMATTER;

/**
 * Get the time-only formatter
 * @returns {Intl.DateTimeFormat} Time formatter
 */
export const getTimeFormatter = () => {
  if (!TIME_FORMATTER) {
    TIME_FORMATTER = new Intl.DateTimeFormat(undefined, TIME_FORMAT_OPTIONS);
  }
  return TIME_FORMATTER;
};

/**
 * Get the date-time formatter
 * @returns {Intl.DateTimeFormat} Date-time formatter
 */
export const getDateTimeFormatter = () => {
  if (!DATE_TIME_FORMATTER) {
    DATE_TIME_FORMATTER = new Intl.DateTimeFormat(
      undefined,
      DATETIME_FORMAT_OPTIONS,
    );
  }
  return DATE_TIME_FORMATTER;
};

/**
 * Format a timestamp for display
 * @param {Date} date - Date object to format
 * @returns {{fullTimestamp: string, timeDisplay: string, tooltipTimestamp: string}} Formatted timestamps
 */
export const formatTimestamp = (date) => {
  const isoTimestamp = date.toISOString();

  return {
    fullTimestamp: isoTimestamp,
    timeDisplay: getTimeFormatter().format(date),
    tooltipTimestamp: getDateTimeFormatter().format(date),
  };
};

/**
 * Format token counts for display.
 * - Values >= 100,000 display as "M" (millions), e.g., "1.2M"
 * - Values > 4096 display as "k" (thousands), e.g., "50k"
 * - Values <= 4096 display as raw numbers
 * @param {number} tokens - Raw token count
 * @returns {string} Formatted token count
 */
export const formatTokens = (tokens) => {
  if (tokens >= 100_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens > 4096) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
};

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Formatted duration string
 */
export const formatDuration = (durationMs) => {
  // Handle edge cases
  if (durationMs < 0) return '0s';

  // For very short durations, show under a second
  if (durationMs < 1000) {
    return '<1s';
  }

  const seconds = Math.floor(durationMs / 1000) % 60;
  const minutes = Math.floor(durationMs / (1000 * 60));

  if (minutes === 0) {
    return `${seconds}sec`;
  } else if (seconds === 0) {
    return `${minutes}min`;
  } else {
    return `${minutes}min, ${seconds}sec`;
  }
};

/**
 * Extracts timestamps from HTML messages.
 */
export class MessageTimestampExtractor {
  /**
   * Extract timestamp from a log line element
   * @param {HTMLElement} element - Log line element
   * @returns {string} Extracted timestamp
   */
  extract(element) {
    const logLine = element.classList.contains('log-line')
      ? element
      : element.querySelector('.log-line');
    if (logLine && logLine.dataset.fullTimestamp) {
      return logLine.dataset.fullTimestamp;
    }

    const text = logLine
      ? logLine.textContent || ''
      : element.textContent || '';
    const match = text.match(/\[(.*?)\]/);
    return match ? match[1] : '';
  }
}
