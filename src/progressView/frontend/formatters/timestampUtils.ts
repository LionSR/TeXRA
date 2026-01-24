// Local imports
import { DATETIME_FORMAT_OPTIONS, TIME_FORMAT_OPTIONS } from './constants';

let timeFormatter: Intl.DateTimeFormat | undefined;
let dateTimeFormatter: Intl.DateTimeFormat | undefined;

export const getTimeFormatter = (): Intl.DateTimeFormat => {
  if (!timeFormatter) {
    timeFormatter = new Intl.DateTimeFormat(undefined, TIME_FORMAT_OPTIONS);
  }
  return timeFormatter;
};

export const getDateTimeFormatter = (): Intl.DateTimeFormat => {
  if (!dateTimeFormatter) {
    dateTimeFormatter = new Intl.DateTimeFormat(
      undefined,
      DATETIME_FORMAT_OPTIONS,
    );
  }
  return dateTimeFormatter;
};

export const formatTimestamp = (date: Date) => {
  const isoTimestamp = date.toISOString();

  return {
    fullTimestamp: isoTimestamp,
    timeDisplay: getTimeFormatter().format(date),
    tooltipTimestamp: getDateTimeFormatter().format(date),
  };
};

export const formatTokens = (tokens: number): string => {
  if (tokens >= 100_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens > 4096) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
};

export const formatDuration = (durationMs: number): string => {
  if (durationMs < 0) return '0s';
  if (durationMs < 1000) {
    return '<1s';
  }

  const seconds = Math.floor(durationMs / 1000) % 60;
  const minutes = Math.floor(durationMs / (1000 * 60));

  if (minutes === 0) {
    return `${seconds}sec`;
  }
  if (seconds === 0) {
    return `${minutes}min`;
  }
  return `${minutes}min, ${seconds}sec`;
};
