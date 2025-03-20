// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import {
  getLinterMessages,
  countDiagnosticsBySeverity,
} from '../utils/linterUtils';
import { getRelativePath } from '../utils/workspaceFileUtils';

const CHANNEL = 'LinterCommands';
logger.initialize(CHANNEL);

export const linterCommands = {
  showLinterMessages: 'coauthor.showLinterMessages',
  countLinterMessages: 'coauthor.countLinterMessages',
};

/**
 * Show linter messages for the current file
 */
export async function handleShowLinterMessages(): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      logger.warn(CHANNEL, 'No active editor found');
      vscode.window.showWarningMessage('Please open a file first');
      return;
    }

    // Convert absolute file path to workspace-relative path
    const absolutePath = editor.document.fileName;
    const relativePath = getRelativePath(absolutePath);
    logger.debug(CHANNEL, `Getting linter messages for ${relativePath}`);

    // Get linter messages
    const messages = getLinterMessages(relativePath);

    if (messages.length === 0) {
      vscode.window.showInformationMessage(
        'No linter issues found in the current file',
      );
      return;
    }

    // Format messages for display
    const formattedMessages = messages.map(
      (msg) =>
        `${msg.severity.toUpperCase()} [${msg.source}]: Line ${msg.line}, Col ${msg.column} - ${msg.message}`,
    );

    // Show in output channel for better formatting
    const outputChannel = vscode.window.createOutputChannel('CoAuthor Linter');
    outputChannel.clear();
    outputChannel.appendLine(`Linter messages for: ${relativePath}`);
    outputChannel.appendLine('');
    formattedMessages.forEach((msg) => outputChannel.appendLine(msg));
    outputChannel.show();
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in showLinterMessages command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error showing linter messages');
  }
}

/**
 * Count and display linter messages by severity for the current file
 */
export async function handleCountLinterMessages(): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      logger.warn(CHANNEL, 'No active editor found');
      vscode.window.showWarningMessage('Please open a file first');
      return;
    }

    // Convert absolute file path to workspace-relative path
    const absolutePath = editor.document.fileName;
    const relativePath = getRelativePath(absolutePath);
    logger.debug(CHANNEL, `Counting linter messages for ${relativePath}`);

    // Count messages by severity
    const counts = countDiagnosticsBySeverity(relativePath);
    const total = counts.errors + counts.warnings + counts.info + counts.hints;

    if (total === 0) {
      vscode.window.showInformationMessage(
        'No linter issues found in the current file',
      );
      return;
    }

    // Show results
    const message = `Linter issues: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info, ${counts.hints} hints`;
    vscode.window.showInformationMessage(message);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in countLinterMessages command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error counting linter messages');
  }
}

export function registerLinterCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      linterCommands.showLinterMessages,
      handleShowLinterMessages,
    ),
    vscode.commands.registerCommand(
      linterCommands.countLinterMessages,
      handleCountLinterMessages,
    ),
  );
  return linterCommands;
}
