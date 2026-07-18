// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  withLaTeXGuard,
  type ActiveFileGuardSuccess,
  type LaTeXGuardOptions,
} from '@frontend/editor/activeFileGuards';
import { runLatexFormatter } from '@latex/texFormatter';
import {
  getTeXCount,
  parseTeXCountStats,
  type TexcountMode,
} from '@latex/texcount';
import { indentLatexFilesInDirectory } from '@latex/formatter/indentDirectory';
import { buildLatexdiffAwareFixInstruction } from '@latex/latexdiff/diffFileNameManager';
import * as logger from '@logger/logUtils';
import replacementEngine from '@replacement/engine';
import { AgentCategory } from '@shared/schemas';
import { delay } from '@utils/core';

import { getIndentTeXNotification } from './latexHousekeepingNotifications';

const CHANNEL = 'LaTeXCommands';

/**
 * Run a LaTeX entry-point command under the active-file guard, surfacing any
 * thrown error through the shared channel logger. Centralizes the
 * `try/withLaTeXGuard/catch` boilerplate every guarded command repeats.
 */
async function runGuardedLatexCommand(
  guard: Omit<LaTeXGuardOptions, 'channel'>,
  errorMessage: string,
  operation: (guardResult: ActiveFileGuardSuccess) => Promise<void>,
): Promise<void> {
  try {
    await withLaTeXGuard({ channel: CHANNEL, ...guard }, operation);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, errorMessage, err);
  }
}

export async function handleIndentTeX(): Promise<void> {
  try {
    const notification = getIndentTeXNotification(
      await indentLatexFilesInDirectory(),
    );
    if (!notification) return;

    if (notification.severity === 'error') {
      await showLoggedErrorMessage(
        CHANNEL,
        notification.message,
        notification.error,
      );
    } else {
      await showLoggedMessage(CHANNEL, notification.message);
    }
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error in indentTeX command', err);
  }
}

export async function handleFixCompilation(): Promise<void> {
  await runGuardedLatexCommand(
    { action: 'fix compilation', saveDocument: true },
    'Error launching LaTeX compilation fixer',
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

export async function handleApplyReplacements(): Promise<void> {
  await runGuardedLatexCommand(
    { action: 'apply replacements', saveDocument: true },
    'Error applying LaTeX replacements',
    async ({ editor }) => {
      const document = editor.document;
      const text = document.getText();

      const processedText = replacementEngine.applyAll(text);
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );

      await editor.edit((editBuilder) => {
        editBuilder.replace(fullRange, processedText);
      });

      await showLoggedInfoMessage(
        CHANNEL,
        'LaTeX replacements applied successfully',
      );
    },
  );
}

export async function handleIndentCurrentTeX(): Promise<void> {
  await runGuardedLatexCommand(
    { action: 'indent LaTeX document', saveDocument: true },
    'Error in indentTeX command',
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
    { action: 'get TeX count' },
    'Error getting tex count',
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
