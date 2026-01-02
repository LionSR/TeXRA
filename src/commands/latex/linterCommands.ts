// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import { showLoggedErrorMessage } from '@common/errors';
import {
  getLinterMessages,
  getSeverityString,
  countDiagnosticsBySeverity,
} from '@frontend/latex/linter';
import {
  getActiveEditorWithGuards,
  logGuardFailure,
} from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';

// Local imports - core

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
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure(
        CHANNEL,
        'show linter messages',
        guardResult.status,
        'LaTeX',
      );
      return;
    }

    const { relativePath } = guardResult;
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
    const formattedMessages = messages.map((msg) => {
      const severity = getSeverityString(msg.severity).toUpperCase();
      const line = msg.range.start.line + 1;
      const col = msg.range.start.character + 1;
      const source = msg.source ?? 'unknown';
      return `${severity} [${source}]: Line ${line}, Col ${col} - ${msg.message}`;
    });

    // Use logger instead of output channel
    logger.info(CHANNEL, `Linter messages for: ${relativePath}`);
    formattedMessages.forEach((msg) => logger.info(CHANNEL, msg));

    // Show a notification
    vscode.window.showInformationMessage(
      `Found ${messages.length} linter issues. Check the log for details.`,
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error showing linter messages', err);
  }
}

/**
 * Count and display linter messages by severity for the current file
 */
export async function handleCountLinterMessages(): Promise<void> {
  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure(
        CHANNEL,
        'count linter messages',
        guardResult.status,
        'LaTeX',
      );
      return;
    }

    const { relativePath } = guardResult;
    logger.debug(CHANNEL, `Counting linter messages for ${relativePath}`);

    // Get linter messages - now uses the async version to ensure build is triggered
    const messages = await getLinterMessages(relativePath);

    // Count by severity
    const counts = countDiagnosticsBySeverity(messages);

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
    await showLoggedErrorMessage(CHANNEL, 'Error counting linter messages', err);
  }
}

/**
 * Fix linter issues in the current file using Claude
 */
export async function handleFixLinterIssues(
  _context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
      saveDocument: true,
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure(
        CHANNEL,
        'fix linter issues',
        guardResult.status,
        'LaTeX',
      );
      return;
    }

    const { relativePath } = guardResult;
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

    const agentConfig = parseAgentConfig({
      agent: 'tex_linter_fix',
      model: 'claude-4-5-sonnet-4-5-latest',
      inputFile: relativePath,
    });

    await executeAgent(agentConfig);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error fixing linter issues', err);
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
