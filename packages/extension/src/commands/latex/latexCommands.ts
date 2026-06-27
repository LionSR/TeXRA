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
import { getTeXCount, type TexcountMode } from '@latex/texcount';
import { indentLatexFilesInDirectory } from '@latex/formatter/indentDirectory';
import { detectGeneratedLatexdiffArtifact } from '@latex/latexdiff/diffFileNameManager';
import * as logger from '@logger/logUtils';
import replacementEngine from '@replacement/engine';
import { delay, filterNotNull } from '@utils/core';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';

import { getIndentTeXNotification } from './latexHousekeepingNotifications';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

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

/**
 * All LaTeX entry-point commands (`indentTeX`, `indentCurrentTeX`,
 * `getTeXCount`, `applyReplacements`, `fixCompilation`) are now
 * registered through the shared command registry in
 * `extensionCommandSurface.ts` (#3771, #3775). This stub is kept for
 * the existing `registerLatexCommands(context)` call site.
 */
export function registerLatexCommands(_context: vscode.ExtensionContext): void {
  /* registration handled by extensionCommandSurface */
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
        agent: 'latexFixer',
        instruction: await buildFixCompilationInstruction(
          editor.document.fileName,
          relativePath,
        ),
      });
    },
  );
}

/**
 * Generated latexdiff artifacts are valid fixer targets — latexdiff itself
 * often emits non-compiling markup that regenerating the diff would only
 * reproduce — but the fixer should know the file is a diff so it repairs the
 * markup in place, and should propagate source-rooted fixes to the source so
 * they survive regeneration.
 */
async function buildFixCompilationInstruction(
  activeFilePath: string,
  relativePath: string,
): Promise<string> {
  const base = `Fix the LaTeX compilation errors in ${relativePath}.`;
  const artifact = detectGeneratedLatexdiffArtifact(activeFilePath);
  if (!artifact) return base;

  const sourceExists = await AbsoluteFS.exists(artifact.sourcePath);
  // A user may legitimately keep a source file named chapter_diff.tex. Treat
  // a plain `_diff` suffix as generated only when the inferred source exists.
  if (artifact.kind === 'workspaceDiff' && !sourceExists) {
    return base;
  }

  const sourceHint = sourceExists
    ? ` generated from ${WorkspaceFS.relativePath(artifact.sourcePath)}`
    : '';
  return [
    base,
    `This file is a latexdiff artifact${sourceHint}.`,
    'If an error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or the DIF preamble blocks), repair the markup in place and keep the diff annotations intact.',
    'If an error originates in the original source document, fix the source too so a regenerated diff stays fixed.',
  ].join(' ');
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
            .filter(filterNotNull);

          await vscode.window.showQuickPick(stats, {
            placeHolder: 'TeXCount Results (press Esc to dismiss)',
            canPickMany: false,
          });
        },
      );
    },
  );
}
