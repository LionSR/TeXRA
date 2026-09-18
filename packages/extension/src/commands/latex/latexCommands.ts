// Standard library imports
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
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
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import { resolveLatexFormatter } from '@latex/formatter/texFormatter';
import { indentLatexFilesInDirectory } from '@latex/formatter/indentDirectory';
import { buildLatexdiffAwareFixInstruction } from '@latex/latexdiff/diffFileNameManager';
import { createLog } from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import { AgentCategory } from '@shared/schemas';

const log = createLog(CHANNEL);

export async function handleIndentTeX(
  session: SessionHandle,
  runtime: ProcessRuntime,
): Promise<void> {
  try {
    const result = await runtime.runPromise(
      indentLatexFilesInDirectory(
        session.roots.workspace,
        resolveLatexFormatter(session.roots),
      ),
    );
    switch (result.status) {
      case 'missing-config':
        await showLoggedMessage(
          CHANNEL,
          `Formatter config file not found at ${result.configPath}`,
        );
        break;
      case 'error':
        await showLoggedErrorMessage(
          CHANNEL,
          'Error during indentation process',
          result.error,
        );
        break;
      case 'disabled':
      case 'formatted':
        break;
    }
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error in indentTeX command', err);
  }
}

export async function handleFixCompilation(
  session: SessionHandle,
  runtime: ProcessRuntime,
): Promise<void> {
  await runGuardedLatexCommand(
    session,
    {
      channel: CHANNEL,
      action: 'fix compilation',
      saveDocument: true,
      errorMessage: 'Error launching LaTeX compilation fixer',
    },
    async ({ editor, relativePath }) => {
      log.info(
        `Launching tool-use agent to fix compilation for: ${relativePath}`,
      );

      await vscode.commands.executeCommand('texra.execute', {
        config: {
          agent: 'latexFixer',
          // latexFixer is a tool-use agent; without this the config category
          // prefaults to workflow and resolveAgentForLaunch can't find it.
          agentCategory: AgentCategory.ToolUse,
          instruction: await runtime.runPromise(
            buildLatexdiffAwareFixInstruction(
              `Fix the LaTeX compilation errors in ${relativePath}.`,
              editor.document.fileName,
              session.roots.workspace,
            ),
          ),
        },
        // This is a "run latexFixer" command, so prefer the helper model.
        preferHelperModel: true,
      });
    },
  );
}

export async function handleIndentCurrentTeX(
  session: SessionHandle,
  runtime: ProcessRuntime,
): Promise<void> {
  await runGuardedLatexCommand(
    session,
    {
      channel: CHANNEL,
      action: 'indent LaTeX document',
      saveDocument: true,
      errorMessage: 'Error in indentTeX command',
    },
    async ({ relativePath }) => {
      log.debug(`Indenting LaTeX file: ${relativePath}`);

      // The directory indent command treats a disabled formatter as a silent
      // no-op (`case 'disabled': break`). The single-file command is an
      // explicit user action, so it notifies instead of succeeding quietly.
      const formatter = resolveLatexFormatter(session.roots);
      if (!formatter) {
        await showLoggedInfoMessage(
          CHANNEL,
          'LaTeX formatter is disabled; no file was indented',
        );
        return;
      }

      const success = await runtime.runPromise(
        formatter.run(
          relativePath,
          session.roots.workspace,
          formatter.configPath,
        ),
      );

      if (success) {
        await sleep(100);
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

export async function handleGetTeXCount(
  session: SessionHandle,
  runtime: ProcessRuntime,
): Promise<void> {
  await runGuardedLatexCommand(
    session,
    {
      channel: CHANNEL,
      action: 'get TeX count',
      errorMessage: 'Error getting tex count',
    },
    async ({ relativePath }) => {
      log.debug(`Getting tex count for: ${relativePath}`);

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

          const { output, errors } = await runtime.runPromise(
            getTeXCount(session.roots.workspace, relativePath, {
              mode: countingMode.value,
              channel: CHANNEL,
            }),
          );

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
