import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import type { z } from 'zod';

/** Valid documentation identifiers for error messages. */
export type DocId = 'intelligent-merge' | 'custom-agents' | 'latex-diff';

const MAX_ERROR_LENGTH = 500;

/** Format an error with a prefix for logging or user messages. */
export function formatError(prefix: string, err: unknown): string {
  const detail = toErrorMessage(err);
  if (detail.length > MAX_ERROR_LENGTH) {
    return `${prefix}: ${detail.substring(0, MAX_ERROR_LENGTH)}...`;
  }
  return `${prefix}: ${detail}`;
}

/** Normalize any thrown value into a user-friendly error message string. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Format a Zod validation error into a human-readable string. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) =>
      i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
    )
    .join(', ');
}

/** Parse data with a Zod schema and show a user-friendly error if parsing fails. */
export async function parseWithErrorDisplay<T>(
  channel: string,
  schema: z.ZodType<T>,
  data: unknown,
  context?: string,
): Promise<T | null> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const prefix = context ? `Invalid ${context}` : 'Invalid input';
    await showLoggedMessage(
      channel,
      `${prefix}: ${formatZodError(result.error)}`,
    );
    return null;
  }
  return result.data;
}

/** Check if an error represents a file-not-found condition (ENOENT or VS Code FileNotFound). */
export function isFileNotFoundError(err: unknown): boolean {
  if (err instanceof vscode.FileSystemError) return err.code === 'FileNotFound';
  return (err as { code?: string })?.code === 'ENOENT';
}

/** Log a formatted error message and return it. */
export function logErrorMessage(
  channel: string,
  prefix: string,
  err: unknown,
): string {
  const message = formatError(prefix, err);
  logger.error(channel, message);
  return message;
}

/** Log a formatted error message and display it to the user. */
export async function showLoggedErrorMessage(
  channel: string,
  prefix: string,
  err: unknown,
): Promise<string> {
  const message = logErrorMessage(channel, prefix, err);
  await vscode.window.showErrorMessage(message);
  return message;
}

/** Log a pre-formatted message and display it to the user as an error. */
export async function showLoggedMessage(
  channel: string,
  message: string,
): Promise<string> {
  logger.error(channel, message);
  await vscode.window.showErrorMessage(message);
  return message;
}

/** Log a message and display it to the user as an information notification. */
export async function showLoggedInfoMessage(
  channel: string,
  message: string,
): Promise<string> {
  logger.info(channel, message);
  await vscode.window.showInformationMessage(message);
  return message;
}

/** Log an error message, display it with a docs action, and open the docs if selected. */
export async function showLoggedMessageWithDocs(
  channel: string,
  message: string,
  docId: DocId,
  actionLabel = 'View Docs',
): Promise<void> {
  logger.error(channel, message);
  const selection = await vscode.window.showErrorMessage(message, actionLabel);
  if (selection !== actionLabel) return;

  try {
    await vscode.commands.executeCommand('texra.openDoc', docId);
  } catch (err) {
    logger.error(channel, `Failed to open documentation: ${err}`);
  }
}
