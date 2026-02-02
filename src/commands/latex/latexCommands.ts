// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@common/errors';
import { withLaTeXGuard } from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';
import replacementEngine from '@replacement/engine';
import { delay } from '@utils/core';
import { runLatexFormatter } from '@latex/texFormatter';
import { getTeXCount, type TexcountMode } from '@latex/texcount';
import { runIndentTeX } from '@housekeeping';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export const latexCommands = {
  indentCurrentTeX: 'texra.indentCurrentTeX',
  getTeXCount: 'texra.getTeXCount',
  indentTeX: 'texra.indentTeX',
  applyReplacements: 'texra.applyReplacements',
};

export function registerLatexCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      latexCommands.indentCurrentTeX,
      handleIndentCurrentTeX,
    ),
    vscode.commands.registerCommand(
      latexCommands.getTeXCount,
      handleGetTeXCount,
    ),
    vscode.commands.registerCommand(latexCommands.indentTeX, runIndentTeX),
    vscode.commands.registerCommand(
      latexCommands.applyReplacements,
      handleApplyReplacements,
    ),
  );
}

async function handleApplyReplacements(): Promise<void> {
  try {
    await withLaTeXGuard(
      { channel: CHANNEL, action: 'apply replacements', saveDocument: true },
      async ({ editor }) => {
        const document = editor.document;
        const text = document.getText();

        // Apply replacements
        const processedText = replacementEngine.applyAll(text);

        // Update document content
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
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'Error applying LaTeX replacements',
      err,
    );
  }
}

async function handleIndentCurrentTeX(): Promise<void> {
  try {
    await withLaTeXGuard(
      {
        channel: CHANNEL,
        action: 'indent LaTeX document',
        saveDocument: true,
      },
      async ({ relativePath }) => {
        logger.debug(CHANNEL, `Indenting LaTeX file: ${relativePath}`);

        // Run the indent operation with relative path
        const success = await runLatexFormatter(relativePath);

        if (success) {
          // Instead of trying to modify the document directly,
          // let VS Code handle the file change notification
          await delay(100); // Small delay to ensure file is written
          await showLoggedInfoMessage(
            CHANNEL,
            'LaTeX file indented successfully',
          );
        } else {
          await showLoggedMessage(CHANNEL, 'Failed to indent LaTeX file');
        }
      },
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error in indentTeX command', err);
  }
}

async function handleGetTeXCount(): Promise<void> {
  try {
    await withLaTeXGuard(
      { channel: CHANNEL, action: 'get TeX count' },
      async ({ relativePath }) => {
        logger.debug(CHANNEL, `Getting tex count for: ${relativePath}`);

        // Ask if user wants to merge included files
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

        // Show progress indicator
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

            // Extract key statistics using regex patterns
            const patterns: [RegExp, string][] = [
              [/Words in text:\s*(\d+)/, 'Text: $1 words'],
              [/Words in headers:\s*(\d+)/, 'Headers: $1'],
              [/Words in float captions:\s*(\d+)/, 'Captions: $1'],
              [/Number of inline math:\s*(\d+)/, 'Inline math: $1'],
              [/Number of displayed math:\s*(\d+)/, 'Display math: $1'],
            ];

            const stats = patterns
              .map(([pattern, template]) => {
                const match = output.match(pattern);
                return match
                  ? { label: template.replace('$1', match[1]) }
                  : null;
              })
              .filter((item): item is { label: string } => item !== null);

            await vscode.window.showQuickPick(stats, {
              placeHolder: 'TeXCount Results (press Esc to dismiss)',
              canPickMany: false,
            });
          },
        );
      },
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error getting tex count', err);
  }
}
