// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - errors
import { showLoggedErrorMessage, showLoggedInfoMessage } from '@common/errors';
import { withLaTeXGuard } from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';
import { pathToLocation } from '@utils/files';
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
import { tikzPictureManager } from '@latex/TikzPictureManager';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export const figureCommands = {
  extractFigurePaths: 'texra.extractFigurePaths',
  extractTikzFigures: 'texra.extractTikzFigures',
  compileTikzFigures: 'texra.compileTikzFigures',
};

/** Simple pluralization helper */
function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/**
 * Execute a LaTeX command with standardized error handling.
 * Wraps withLaTeXGuard and catches any errors to show them to the user.
 */
async function runLaTeXCommand(
  action: string,
  commandName: string,
  operation: (context: { relativePath: string }) => Promise<void>,
): Promise<void> {
  try {
    await withLaTeXGuard({ channel: CHANNEL, action }, operation);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, `${commandName} command failed`, err);
  }
}

export function registerFigureCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      figureCommands.extractFigurePaths,
      handleExtractFigurePaths,
    ),
    vscode.commands.registerCommand(
      figureCommands.extractTikzFigures,
      handleExtractTikzFigures,
    ),
    vscode.commands.registerCommand(
      figureCommands.compileTikzFigures,
      handleCompileTikzFigures,
    ),
  );
}

async function handleExtractFigurePaths(): Promise<void> {
  await runLaTeXCommand(
    'extract figure paths',
    'extractFigurePaths',
    async ({ relativePath: filePath }) => {
      logger.debug(CHANNEL, `Processing LaTeX file: ${filePath}`);

      const figurePaths = await extractFigurePathsFromLatex(
        pathToLocation(filePath),
      );

      if (figurePaths.length > 0) {
        const selected = await vscode.window.showQuickPick(figurePaths, {
          placeHolder: 'Found figures (select to copy path)',
          canPickMany: false,
        });

        if (selected) {
          await vscode.env.clipboard.writeText(selected);
          await showLoggedInfoMessage(
            CHANNEL,
            `Copied figure path: ${selected}`,
          );
        }
      } else {
        await showLoggedInfoMessage(
          CHANNEL,
          'No figures found in the current file',
        );
      }
    },
  );
}

async function handleExtractTikzFigures(): Promise<void> {
  await runLaTeXCommand(
    'extract TikZ figures',
    'extractTikzFigures',
    async ({ relativePath: filePath }) => {
      logger.debug(
        CHANNEL,
        `Processing LaTeX file for TikZ figures: ${filePath}`,
      );

      const labeledTikzPictures = await tikzPictureManager.extract(
        pathToLocation(filePath),
      );

      if (labeledTikzPictures.length > 0) {
        const items = labeledTikzPictures.map(
          ([label, tikzpicturess]: [string, string[]]) => ({
            label: `${label} (${tikzpicturess.length} TikZ ${pluralize(tikzpicturess.length, 'picture')})`,
            description: `Figure with label: ${label}`,
            detail: `${tikzpicturess[0].substring(0, 100)}...`,
          }),
        );

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Found TikZ figures (select to copy label)',
          canPickMany: false,
        });

        if (selected) {
          const label = selected.label.split(' (')[0];
          await vscode.env.clipboard.writeText(label);
          await showLoggedInfoMessage(CHANNEL, `Copied figure label: ${label}`);
        }
      } else {
        await showLoggedInfoMessage(
          CHANNEL,
          'No TikZ figures found in the current file',
        );
      }
    },
  );
}

async function handleCompileTikzFigures(): Promise<void> {
  await runLaTeXCommand(
    'compile TikZ figures',
    'compileTikzFigures',
    async ({ relativePath: filePath }) => {
      logger.debug(
        CHANNEL,
        `Processing LaTeX file for TikZ compilation: ${filePath}`,
      );

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Compiling TikZ Figures',
          cancellable: false,
        },
        async (progress) => {
          progress.report({
            message: 'Extracting and compiling TikZ pictures...',
          });

          const compiledFiles = await tikzPictureManager.compile(
            pathToLocation(filePath),
          );

          if (compiledFiles.length > 0) {
            const items = compiledFiles.map((fileLocation) => ({
              label: path.basename(fileLocation.absolutePath),
              description: fileLocation.absolutePath,
              file: fileLocation.absolutePath,
            }));

            const selected = await vscode.window.showQuickPick(items, {
              placeHolder: 'Compiled TikZ figures (select to open)',
              canPickMany: false,
            });

            if (selected) {
              const uri = vscode.Uri.file(selected.file);
              await vscode.commands.executeCommand('vscode.open', uri);
            }

            await showLoggedInfoMessage(
              CHANNEL,
              `Successfully compiled ${compiledFiles.length} TikZ ${pluralize(compiledFiles.length, 'figure')}`,
            );
          } else {
            await showLoggedInfoMessage(
              CHANNEL,
              'No TikZ figures found to compile',
            );
          }
        },
      );
    },
  );
}
