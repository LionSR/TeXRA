import * as vscode from 'vscode';
import { countPdfPages } from '../utils/imgUtils';
import { debug, error, initializeLogging } from '../utils/logUtils';
import { getRelativePath } from '../utils/commonUtils';

const CHANNEL = 'ImageCommands';
initializeLogging(CHANNEL);

export const imageCommands = {
  countPdfPages: 'coauthor.countPdfPages',
};

export function registerImageCommands(context: vscode.ExtensionContext) {
  const disposables = [
    vscode.commands.registerCommand(imageCommands.countPdfPages, async () => {
      try {
        // Open file picker dialog
        const fileUris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: {
            'PDF files': ['pdf'],
          },
          title: 'Select PDF file to count pages',
        });

        if (!fileUris || fileUris.length === 0) {
          return;
        }

        const selectedFile = getRelativePath(fileUris[0].fsPath);
        debug(CHANNEL, `Processing PDF file: ${selectedFile}`);

        const pageCount = await countPdfPages(selectedFile);
        if (pageCount > 0) {
          vscode.window.showInformationMessage(
            `The PDF has ${pageCount} pages`,
          );
        } else {
          vscode.window.showErrorMessage('Could not count pages in the PDF');
        }
      } catch (err) {
        error(
          CHANNEL,
          `Error in countPdfPages command: ${err instanceof Error ? err.message : String(err)}`,
        );
        vscode.window.showErrorMessage('Error counting PDF pages');
      }
    }),
  ];

  context.subscriptions.push(...disposables);
  debug(CHANNEL, 'Image commands registered');
  return disposables;
}
