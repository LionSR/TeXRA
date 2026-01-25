/**
 * Timestamp formatting utilities for progress view formatters.
 */

// Local imports - formatter helpers
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
export function getDateTimeFormatter(): Intl.DateTimeFormat {
  DATE_TIME_FORMATTER ??= new Intl.DateTimeFormat(
    undefined,
    DATETIME_FORMAT_OPTIONS,
  );
  return DATE_TIME_FORMATTER;
}

/** Format a timestamp for display. */
export function formatTimestamp(date: Date): {
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

/** Format token counts for display. Values >= 100k display as "M", > 4096 as "k", otherwise raw. */
export function formatTokens(tokens: number): string {
  if (tokens >= 100_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens > 4096) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

/** Format duration in milliseconds to human-readable string. */
export function formatDuration(durationMs: number): string {
  if (durationMs < 0) return '0s';
  if (durationMs < 1000) return '<1s';

  const seconds = Math.floor(durationMs / 1000) % 60;
  const minutes = Math.floor(durationMs / (1000 * 60));

  if (minutes === 0) return `${seconds}sec`;
  if (seconds === 0) return `${minutes}min`;
  return `${minutes}min, ${seconds}sec`;
}

/**
 * Extracts timestamps from HTML messages.
 */
export class MessageTimestampExtractor {
  /** Extract timestamp from a log line element. */
  extract(element: HTMLElement): string {
    const logLine = element.classList.contains('log-line')
      ? element
      : element.querySelector('.log-line');
    if (logLine instanceof HTMLElement && logLine.dataset.fullTimestamp) {
      return logLine.dataset.fullTimestamp;
    }

    const text = logLine
      ? logLine.textContent || ''
      : element.textContent || '';
    const match = text.match(/\[(.*?)\]/);
    return match ? match[1] : '';
  }
}
