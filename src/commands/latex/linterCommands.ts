// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentConfigSchema } from '@agent/core';
import { executeAgent } from '@agent/runtime/executeAgent';
import { showLoggedErrorMessage } from '@common/errors';
import {
  countBySeverity,
  getSeverityLabel,
} from '@frontend/vscode/vscodeDiagnostics';
import { getLinterMessages } from '@frontend/latex/linter';
import { withLaTeXGuard } from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';

const CHANNEL = 'LinterCommands';
logger.initialize(CHANNEL);

export const linterCommands = {
  showLinterMessages: 'texra.showLinterMessages',
  countLinterMessages: 'texra.countLinterMessages',
  fixLinterIssues: 'texra.fixLinterIssues',
};

function showNoIssuesMessage(): void {
  vscode.window.showInformationMessage(
    'No linter issues found in the current file',
  );
}

/**
 * Show linter messages for the current file
 */
export async function handleShowLinterMessages(): Promise<void> {
  await withLaTeXGuard(
    { channel: CHANNEL, action: 'show linter messages' },
    async ({ relativePath }) => {
      logger.debug(CHANNEL, `Getting linter messages for ${relativePath}`);

      const messages = await getLinterMessages(relativePath);

      if (messages.length === 0) {
        showNoIssuesMessage();
        return;
      }

      // Format and log messages
      logger.info(CHANNEL, `Linter messages for: ${relativePath}`);
      for (const msg of messages) {
        const severity = getSeverityLabel(msg.severity).toUpperCase();
        const line = msg.range.start.line + 1;
        const col = msg.range.start.character + 1;
        const source = msg.source ?? 'unknown';
        logger.info(
          CHANNEL,
          `${severity} [${source}]: Line ${line}, Col ${col} - ${msg.message}`,
        );
      }

      vscode.window.showInformationMessage(
        `Found ${messages.length} linter issues. Check the log for details.`,
      );
    },
  ).catch((err) =>
    showLoggedErrorMessage(CHANNEL, 'Error showing linter messages', err),
  );
}

/**
 * Count and display linter messages by severity for the current file
 */
export async function handleCountLinterMessages(): Promise<void> {
  await withLaTeXGuard(
    { channel: CHANNEL, action: 'count linter messages' },
    async ({ relativePath }) => {
      logger.debug(CHANNEL, `Counting linter messages for ${relativePath}`);

      const messages = await getLinterMessages(relativePath);
      const counts = countBySeverity(messages);
      const total =
        counts.errors + counts.warnings + counts.info + counts.hints;

      if (total === 0) {
        showNoIssuesMessage();
        return;
      }

      vscode.window.showInformationMessage(
        `Linter issues: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info, ${counts.hints} hints`,
      );
    },
  ).catch((err) =>
    showLoggedErrorMessage(CHANNEL, 'Error counting linter messages', err),
  );
}

/**
 * Fix linter issues in the current file using Claude
 */
export async function handleFixLinterIssues(): Promise<void> {
  await withLaTeXGuard(
    { channel: CHANNEL, action: 'fix linter issues', saveDocument: true },
    async ({ relativePath }) => {
      logger.debug(CHANNEL, `Fixing linter issues for ${relativePath}`);

      const issues = await getLinterMessages(relativePath);
      if (issues.length === 0) {
        showNoIssuesMessage();
        return;
      }

      logger.info(
        CHANNEL,
        `Found ${issues.length} linter issues in ${relativePath}`,
      );

      const agentConfig = AgentConfigSchema.parse({
        agent: 'tex_linter_fix',
        model: 'claude-4-5-sonnet-4-5-latest',
        inputFile: relativePath,
      });

      await executeAgent(agentConfig);
    },
  ).catch((err) =>
    showLoggedErrorMessage(CHANNEL, 'Error fixing linter issues', err),
  );
}

export function registerLinterCommands(context: vscode.ExtensionContext): void {
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
}
