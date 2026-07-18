// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { withLaTeXGuard } from '@frontend/editor/activeFileGuards';
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
import { TikzPictureManager } from '@latex/TikzPictureManager';
import * as logger from '@logger/logUtils';
import { pathToLocation } from '@utils/files';
import { pluralize } from '@utils/text/stringUtils';

const CHANNEL = 'TestCommands';

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

export async function handleExtractFigurePaths(): Promise<void> {
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
          prompt: 'Select a figure path to copy to the clipboard',
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

export async function handleExtractTikzFigures(): Promise<void> {
  await runLaTeXCommand(
    'extract TikZ figures',
    'extractTikzFigures',
    async ({ relativePath: filePath }) => {
      logger.debug(
        CHANNEL,
        `Processing LaTeX file for TikZ figures: ${filePath}`,
      );

      const labeledTikzPictures = await TikzPictureManager.extract(
        pathToLocation(filePath),
      );

      if (labeledTikzPictures.length > 0) {
        const items = labeledTikzPictures.map(([label, pictures]) => ({
          label: `${label} (${pictures.length} TikZ ${pluralize(pictures.length, 'picture')})`,
          description: `Figure with label: ${label}`,
          detail: `${pictures[0].slice(0, 100)}...`,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Found TikZ figures (select to copy label)',
          prompt: 'Select a TikZ figure label to copy to the clipboard',
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

export async function handleCompileTikzFigures(): Promise<void> {
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

          const compiledFiles = await TikzPictureManager.compile(
            pathToLocation(filePath),
          );

          if (compiledFiles.length > 0) {
            const items = compiledFiles.map((fileLocation) => ({
              label: path.basename(fileLocation.absolutePath),
              description: path.dirname(fileLocation.absolutePath),
              resourceUri: vscode.Uri.file(fileLocation.absolutePath),
              iconPath: vscode.ThemeIcon.File,
              file: fileLocation.absolutePath,
            }));

            const selected = await vscode.window.showQuickPick(items, {
              placeHolder: 'Compiled TikZ figures (select to open)',
              prompt: 'Select a compiled TikZ figure to open in the editor',
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
