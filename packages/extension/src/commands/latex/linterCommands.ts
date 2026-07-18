// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getLinterMessages } from '@frontend/latex/linter';
import { withLaTeXGuard } from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';
import {
  countBySeverity,
  getSeverityLabel,
} from '@utils/diagnostics/diagnosticFormatting';

const CHANNEL = 'LinterCommands';

function showNoIssuesMessage(): void {
  vscode.window.showInformationMessage(
    'No linter issues found in the current file',
  );
}

export async function handleShowLinterMessages(): Promise<void> {
  try {
    await withLaTeXGuard(
      { channel: CHANNEL, action: 'show linter messages' },
      async ({ relativePath }) => {
        logger.debug(CHANNEL, `Getting linter messages for ${relativePath}`);

        const messages = await getLinterMessages(relativePath);

        if (messages.length === 0) {
          showNoIssuesMessage();
          return;
        }

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
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error showing linter messages', err);
  }
}

export async function handleCountLinterMessages(): Promise<void> {
  try {
    await withLaTeXGuard(
      { channel: CHANNEL, action: 'count linter messages' },
      async ({ relativePath }) => {
        logger.debug(CHANNEL, `Counting linter messages for ${relativePath}`);

        const messages = await getLinterMessages(relativePath);

        if (messages.length === 0) {
          showNoIssuesMessage();
          return;
        }

        const counts = countBySeverity(messages);
        vscode.window.showInformationMessage(
          `Linter issues: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info, ${counts.hints} hints`,
        );
      },
    );
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'Error counting linter messages',
      err,
    );
  }
}
