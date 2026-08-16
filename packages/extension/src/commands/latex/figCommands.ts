// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { runGuardedLatexCommand } from '@frontend/editor/activeFileGuards';
import { showLoggedInfoMessage } from '@frontend/ui/errorHandlingUtils';
import { TikzPictureManager } from '@latex/TikzPictureManager';
import { createLog } from '@logger/logUtils';
import { pathToLocation } from '@utils/files/fileLocation';
import { pluralize, truncateWithEllipsis } from '@utils/text/stringUtils';

const CHANNEL = 'FigCommands';
const log = createLog(CHANNEL);

export async function handleExtractTikzFigures(): Promise<void> {
  await runGuardedLatexCommand(
    {
      channel: CHANNEL,
      action: 'extract TikZ figures',
      errorMessage: 'extractTikzFigures command failed',
    },
    async ({ relativePath: filePath }) => {
      log.debug(`Processing LaTeX file for TikZ figures: ${filePath}`);

      const labeledTikzPictures = await TikzPictureManager.extract(
        pathToLocation(filePath),
      );

      if (labeledTikzPictures.length > 0) {
        const items = labeledTikzPictures.map(([label, pictures]) => ({
          label: `${label} (${pictures.length} TikZ ${pluralize(pictures.length, 'picture')})`,
          description: `Figure with label: ${label}`,
          detail: truncateWithEllipsis(pictures[0], 100),
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
  await runGuardedLatexCommand(
    {
      channel: CHANNEL,
      action: 'compile TikZ figures',
      errorMessage: 'compileTikzFigures command failed',
    },
    async ({ relativePath: filePath }) => {
      log.debug(`Processing LaTeX file for TikZ compilation: ${filePath}`);

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
