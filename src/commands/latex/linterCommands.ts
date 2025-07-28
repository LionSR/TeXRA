// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utils
import { getLinterMessages } from '@frontend/latex/linter';
import { WorkspaceFS } from '@utils/files';

// Local imports - core
import { executeAgent } from '@agent/runtime/executeAgent';

const CHANNEL = 'LinterCommands';
logger.initialize(CHANNEL);

export const linterCommands = {
  showLinterMessages: 'texra.showLinterMessages',
  countLinterMessages: 'texra.countLinterMessages',
  fixLinterIssues: 'texra.fixLinterIssues',
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
    const relativePath = WorkspaceFS.relativePath(absolutePath);
    logger.debug(CHANNEL, `Getting linter messages for ${relativePath}`);

    // Get linter messages
    const messages = await getLinterMessages(relativePath);

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

    // Use logger instead of output channel
    logger.info(CHANNEL, `Linter messages for: ${relativePath}`);
    formattedMessages.forEach((msg) => logger.info(CHANNEL, msg));

    // Show a notification
    vscode.window.showInformationMessage(
      `Found ${messages.length} linter issues. Check the log for details.`,
    );
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
    const relativePath = WorkspaceFS.relativePath(absolutePath);
    logger.debug(CHANNEL, `Counting linter messages for ${relativePath}`);

    // Get linter messages - now uses the async version to ensure build is triggered
    const messages = await getLinterMessages(relativePath);

    // Count by severity
    const counts = {
      errors: 0,
      warnings: 0,
      info: 0,
      hints: 0,
    };

    messages.forEach((msg) => {
      switch (msg.severity) {
        case 'error':
          counts.errors++;
          break;
        case 'warning':
          counts.warnings++;
          break;
        case 'info':
          counts.info++;
          break;
        case 'hint':
          counts.hints++;
          break;
      }
    });

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

/**
 * Fix linter issues in the current file using Claude
 */
export async function handleFixLinterIssues(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      logger.warn(CHANNEL, 'No active editor found');
      vscode.window.showWarningMessage('Please open a file first');
      return;
    }

    // Save any unsaved changes before attempting to fix
    if (editor.document.isDirty) {
      await editor.document.save();
    }

    // Convert absolute file path to workspace-relative path
    const absolutePath = editor.document.fileName;
    const relativePath = WorkspaceFS.relativePath(absolutePath);
    logger.debug(CHANNEL, `Fixing linter issues for ${relativePath}`);

    // Check if there are any linter issues
    const issues = await getLinterMessages(relativePath);
    if (issues.length === 0) {
      vscode.window.showInformationMessage(
        'No linter issues found in the current file',
      );
      return;
    }

    // Log the total number of issues found
    logger.info(
      CHANNEL,
      `Found ${issues.length} linter issues in ${relativePath}`,
    );

    await executeAgent(
      {
        agent: 'tex_linter_fix',
        model: 'claude-3-7-sonnet-latest',
        inputFile: relativePath,
      },
      context,
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in fixLinterIssues command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(
      `Error fixing linter issues: ${String(err)}`,
    );
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
    vscode.commands.registerCommand(linterCommands.fixLinterIssues, () =>
      handleFixLinterIssues(context),
    ),
  );
  return linterCommands;
}
