// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { runGuardedLatexCommand } from '@frontend/editor/activeFileGuards';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  getTeXCount,
  parseTeXCountStats,
  type TexcountMode,
} from '@latex/texcount';
import { runLatexFormatter } from '@latex/formatter/texFormatter';
import { indentLatexFilesInDirectory } from '@latex/formatter/indentDirectory';
import { buildLatexdiffAwareFixInstruction } from '@latex/latexdiff/diffFileNameManager';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import * as logger from '@logger/logUtils';
import { AgentCategory } from '@shared/schemas';
import { delay } from '@utils/core';

import {
  getIndentTeXNotification,
  showLatexHousekeepingNotification,
} from './latexHousekeepingNotifications';

export async function handleIndentTeX(): Promise<void> {
  try {
    const notification = getIndentTeXNotification(
      await indentLatexFilesInDirectory(),
    );
    if (!notification) return;
    await showLatexHousekeepingNotification(CHANNEL, notification);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error in indentTeX command', err);
  }
}

export async function handleFixCompilation(): Promise<void> {
  await runGuardedLatexCommand(
    {
      channel: CHANNEL,
      action: 'fix compilation',
      saveDocument: true,
      errorMessage: 'Error launching LaTeX compilation fixer',
    },
    async ({ editor, relativePath }) => {
      logger.info(
        CHANNEL,
        `Launching tool-use agent to fix compilation for: ${relativePath}`,
      );

      await vscode.commands.executeCommand('texra.execute', {
        config: {
          agent: 'latexFixer',
          // latexFixer is a tool-use agent; without this the config category
          // prefaults to workflow and resolveAgentForLaunch can't find it.
          agentCategory: AgentCategory.ToolUse,
          instruction: await buildLatexdiffAwareFixInstruction(
            `Fix the LaTeX compilation errors in ${relativePath}.`,
            editor.document.fileName,
          ),
        },
        // This is a "run latexFixer" command, so prefer the helper model.
        preferHelperModel: true,
      });
    },
  );
}

export async function handleIndentCurrentTeX(): Promise<void> {
  await runGuardedLatexCommand(
    {
      channel: CHANNEL,
      action: 'indent LaTeX document',
      saveDocument: true,
      errorMessage: 'Error in indentTeX command',
    },
    async ({ relativePath }) => {
      logger.debug(CHANNEL, `Indenting LaTeX file: ${relativePath}`);

      const success = await runLatexFormatter(relativePath);

      if (success) {
        await delay(100);
        await showLoggedInfoMessage(
          CHANNEL,
          'LaTeX file indented successfully',
        );
      } else {
        await showLoggedMessage(CHANNEL, 'Failed to indent LaTeX file');
      }
    },
  );
}

export async function handleGetTeXCount(): Promise<void> {
  await runGuardedLatexCommand(
    {
      channel: CHANNEL,
      action: 'get TeX count',
      errorMessage: 'Error getting tex count',
    },
    async ({ relativePath }) => {
      logger.debug(CHANNEL, `Getting tex count for: ${relativePath}`);

      const countingMode = await vscode.window.showQuickPick<
        vscode.QuickPickItem & { value: TexcountMode }
      >(
        [
          { label: 'Count main file only', value: 'separate' as const },
          {
            label: 'Follow \\input/\\include and combine',
            value: 'include' as const,
          },
        ],
        {
          placeHolder: 'Count options',
          canPickMany: false,
        },
      );

      if (!countingMode) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Counting LaTeX Document',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Running texcount...' });

          const { output, errors } = await getTeXCount(relativePath, {
            mode: countingMode.value,
            channel: CHANNEL,
          });

          if (!output) {
            const message =
              errors[0] ??
              'Failed to get tex count. Please verify the file path.';
            await showLoggedMessage(CHANNEL, message);
            return;
          }

          const stats = parseTeXCountStats(output);

          await vscode.window.showQuickPick(stats, {
            placeHolder: 'TeXCount Results (press Esc to dismiss)',
            canPickMany: false,
          });
        },
      );
    },
  );
}
