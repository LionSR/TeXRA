// Utility functions for consistent error logging and formatting

// Local imports - log
import * as logger from '../logger/logUtils';

/**
 * Format an error with a prefix for logging or user messages.
 */
export function formatError(prefix: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${detail}`;
}

/**
 * Log the formatted error and return the message.
 */
export function logErrorMessage(
  channel: string,
  prefix: string,
  err: unknown,
): string {
  const message = formatError(prefix, err);
  logger.error(channel, message);
  return message;
}
