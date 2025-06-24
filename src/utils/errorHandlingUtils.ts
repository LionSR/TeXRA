// Utility functions for consistent error logging and formatting

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

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

/**
 * Log the formatted error, show it to the user, and return the message.
 */
export async function showLoggedErrorMessage(
  channel: string,
  prefix: string,
  err?: unknown,
): Promise<string> {
  const message =
    err !== undefined ? logErrorMessage(channel, prefix, err) : prefix;
  if (err === undefined) {
    logger.error(channel, message);
  }
  await vscode.window.showErrorMessage(message);
  return message;
}
