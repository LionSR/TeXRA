// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utils
import {
  getLinterMessages,
  countDiagnosticsBySeverity,
} from '../utils/linterUtils';
import { getRelativePath } from '../utils/workspaceFileUtils';
import { TeXLinterFixAgent } from '../AnthropicTool';

const CHANNEL = 'LinterCommands';
logger.initialize(CHANNEL);

export const linterCommands = {
  showLinterMessages: 'coauthor.showLinterMessages',
  countLinterMessages: 'coauthor.countLinterMessages',
  fixLinterIssues: 'coauthor.fixLinterIssues',
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

/**
 * Fix linter issues in the current file using Claude
 */
export async function handleFixLinterIssues(): Promise<void> {
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
    const relativePath = getRelativePath(absolutePath);
    logger.debug(CHANNEL, `Fixing linter issues for ${relativePath}`);

    // Check if there are any linter issues
    const issues = getLinterMessages(relativePath);
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

    // Create the agent
    const linterFixAgent = new TeXLinterFixAgent();

    // Show progress indicator
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Fixing linter issues using Claude',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Analyzing issues...' });

        // Run the fix operation
        const result = await linterFixAgent.fixIssues(relativePath);

        if (result) {
          progress.report({ message: 'Fixed successfully!' });
        } else {
          progress.report({ message: 'Could not fix all issues' });
        }

        // Return a Promise that resolves after 1.5 seconds to give user time to see the result
        return new Promise((resolve) => setTimeout(resolve, 1500));
      },
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
    vscode.commands.registerCommand(
      linterCommands.fixLinterIssues,
      handleFixLinterIssues,
    ),
  );
  return linterCommands;
}
