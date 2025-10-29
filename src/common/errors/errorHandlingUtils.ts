/**
 * Utility functions for consistent error logging and formatting across the TeXRA extension.
 *
 * This module provides a standardized approach to error handling that:
 * - Ensures consistent error message formatting
 * - Centralizes logging logic
 * - Provides both silent logging and user-visible error display
 * - Handles various error types (Error objects, strings, primitives, etc.)
 *
 * @fileoverview Error handling utilities for consistent logging and user feedback
 * @author TeXRA.ai
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports - logging
import * as logger from '@logger/logUtils';

/**
 * Valid documentation identifiers for error messages.
 * This ensures type safety when referencing documentation sections.
 */
export type DocId =
  | 'intelligent-merge'
  | 'custom-agents'
  | 'tool-integration'
  | 'latex-diff';

/** Maximum length for error details before truncation */
const MAX_ERROR_LENGTH = 500;

/**
 * Format an error with a prefix for logging or user messages.
 *
 * This is the core formatting function used by all other error handling utilities.
 * It handles various error types consistently:
 * - Error objects: uses the .message property
 * - Primitives (string, number, boolean, null, undefined): converts to string
 * - Objects and arrays: converts to string representation
 *
 * @param prefix - The error message prefix (e.g., "Failed to save file", "API request failed")
 * @param err - The error to format (can be Error object, string, or any other type)
 * @returns A formatted error message in the format "prefix: error_detail"
 *
 * @example
 * ```typescript
 * const error = new Error("File not found");
 * const formatted = formatError("Failed to read config", error);
 * // Returns: "Failed to read config: File not found"
 *
 * const stringError = "Invalid parameter";
 * const formatted2 = formatError("Validation failed", stringError);
 * // Returns: "Validation failed: Invalid parameter"
 * ```
 */
export function formatError(prefix: string, err: unknown): string {
  let detail = err instanceof Error ? err.message : String(err);

  // Truncate overly long error details for better readability
  if (detail.length > MAX_ERROR_LENGTH) {
    detail = detail.substring(0, MAX_ERROR_LENGTH) + '...';
  }

  return `${prefix}: ${detail}`;
}

/**
 * Normalize any thrown value into a user-friendly error message string.
 *
 * Unlike {@link formatError}, this helper only returns the detail portion of
 * the message, making it suitable for composing custom prefixes or structured
 * payloads. Centralizing the coercion keeps error messaging consistent across
 * flows and model handlers.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === undefined) {
    return 'undefined';
  }
  if (err === null) {
    return 'null';
  }
  return String(err);
}

/**
 * Produce a consistent, human-readable description for JSON parsing failures.
 *
 * Centralising this logic keeps error messaging aligned across flow nodes and
 * model handlers regardless of which SDK triggered the malformed payload. The
 * helper strips redundant whitespace and guarantees a fallback message when the
 * upstream error omits a detail string.
 */
export function normalizeJsonParseError(prefix: string, err: unknown): string {
  const detail = toErrorMessage(err).trim();
  const message = detail.length > 0 ? detail : 'Unknown JSON parsing error';
  return `${prefix}: ${message}`;
}

/**
 * Log a formatted error message and return the formatted message.
 *
 * This function combines error formatting with logging. It:
 * 1. Formats the error using formatError()
 * 2. Logs the formatted message to the specified channel
 * 3. Returns the formatted message for further use
 *
 * Use this when you want to log an error but not display it to the user.
 *
 * @param channel - The logging channel to use (e.g., "FileSystem", "API", "Validation")
 * @param prefix - The error message prefix describing the operation that failed
 * @param err - The error to format and log
 * @returns The formatted error message that was logged
 *
 * @example
 * ```typescript
 * try {
 *   await fs.readFile(filePath);
 * } catch (err) {
 *   const message = logErrorMessage("FileSystem", "Failed to read config file", err);
 *   // Logs: "Failed to read config file: ENOENT: no such file or directory"
 *   // Returns the same message for further processing
 * }
 * ```
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
 * Log a formatted error message and display it to the user.
 *
 * This is the primary function for handling errors that should be shown to the user.
 * It combines all error handling steps:
 * 1. Formats the error using formatError()
 * 2. Logs the formatted message to the specified channel
 * 3. Displays the error message to the user via VS Code's error notification
 * 4. Returns the formatted message for further use
 *
 * Use this when an error occurs that the user should be notified about.
 *
 * @param channel - The logging channel to use (e.g., "FileSystem", "API", "Commands")
 * @param prefix - The error message prefix describing what operation failed
 * @param err - The error object, string, or other value to format and display
 * @returns A promise that resolves to the formatted error message that was displayed
 *
 * @example
 * ```typescript
 * try {
 *   const result = await apiCall();
 * } catch (err) {
 *   await showLoggedErrorMessage("API", "Failed to fetch user data", err);
 *   // This will:
 *   // 1. Log: "Failed to fetch user data: Network error"
 *   // 2. Show user popup: "Failed to fetch user data: Network error"
 *   // 3. Return: "Failed to fetch user data: Network error"
 * }
 * ```
 */
export async function showLoggedErrorMessage(
  channel: string,
  prefix: string,
  err: unknown,
): Promise<string> {
  const message = logErrorMessage(channel, prefix, err);
  await vscode.window.showErrorMessage(message);
  return message;
}

/**
 * Log a pre-formatted message and display it to the user as an error.
 *
 * Use this function when you already have a complete, properly formatted error message
 * and don't need additional error object processing. This is useful for:
 * - Validation errors with custom messages
 * - Configuration errors
 * - Messages that don't originate from caught exceptions
 *
 * @param channel - The logging channel to use (e.g., "Validation", "Configuration")
 * @param message - The complete error message to log and display to the user
 * @returns A promise that resolves to the message that was displayed
 *
 * @example
 * ```typescript
 * // Validation error scenario
 * if (!inputFile || !agent || !model) {
 *   await showLoggedMessage("Validation", "Missing required parameters: inputFile, agent, and model must be provided");
 *   return;
 * }
 *
 * // Configuration error scenario
 * if (!workspacePath) {
 *   await showLoggedMessage("Configuration", "No workspace folder is currently open");
 *   return;
 * }
 * ```
 */
export async function showLoggedMessage(
  channel: string,
  message: string,
): Promise<string> {
  logger.error(channel, message);
  await vscode.window.showErrorMessage(message);
  return message;
}

/**
 * Log an error message, display it with a docs action and open the docs if selected.
 *
 * This helper keeps messaging consistent when providing quick access to
 * documentation for resolving the error.
 *
 * @param channel - The logging channel to use (e.g., "Configuration")
 * @param message - The error message to log and display
 * @param docId - Identifier for the documentation to open (must be a valid DocId)
 * @param actionLabel - Label for the docs action button (defaults to 'View Docs')
 */
export async function showLoggedMessageWithDocs(
  channel: string,
  message: string,
  docId: DocId,
  actionLabel = 'View Docs',
): Promise<void> {
  logger.error(channel, message);
  const selection = await vscode.window.showErrorMessage(message, actionLabel);
  if (selection === actionLabel) {
    // Use try-catch to prevent uncaught errors if the command fails
    // (e.g., during activation race conditions or if the command is not registered)
    try {
      await vscode.commands.executeCommand('texra.openDoc', docId);
    } catch (err) {
      // Log the error but don't show another error message to avoid error cascade
      logger.error(channel, `Failed to open documentation: ${err}`);
    }
  }
}
