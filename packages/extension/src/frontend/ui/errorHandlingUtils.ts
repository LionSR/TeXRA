import * as vscode from 'vscode';

import { formatError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Valid documentation identifiers for error messages. */
export type DocId = 'intelligent-merge' | 'custom-agents' | 'latex-diff';

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

/**
 * Show a modal warning dialog with `actionLabel` as the primary button
 * (plus any `otherLabels`, in order) and resolve `true` iff the user picked
 * `actionLabel`. Dismissing the dialog (Escape/X) resolves `false`, same as
 * picking any other button.
 */
export async function confirmModal(
  message: string,
  actionLabel: string,
  ...otherLabels: string[]
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    actionLabel,
    ...otherLabels,
  );
  return choice === actionLabel;
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
    logger.error(
      channel,
      `Failed to open documentation: ${toErrorMessage(err)}`,
    );
  }
}
