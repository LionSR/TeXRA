import * as vscode from 'vscode';
import * as path from 'path';
import * as logger from '../logger/logUtils';
import { downloadArxivSource, validateArxivId } from '../utils/arXivUtils';

const CHANNEL = 'arXivCommands';

// Command IDs
export const arXivCommands = {
  downloadArXivSource: 'texra.downloadArXivSource',
};

/**
 * Register arXiv-related commands
 * @param context The extension context
 * @returns An object with the registered commands
 */
export function registerArXivCommands(context: vscode.ExtensionContext) {
  logger.initialize(CHANNEL);

  // Register the download arXiv source command
  const downloadCommand = vscode.commands.registerCommand(
    arXivCommands.downloadArXivSource,
    async () => {
      try {
        // Ask for arXiv ID
        const arxivId = await vscode.window.showInputBox({
          placeHolder: 'e.g., 2404.12175',
          prompt: 'Enter arXiv ID',
          validateInput: validateArxivId,
        });

        if (!arxivId) {
          return; // User cancelled
        }

        // Ask if user wants to auto-indent LaTeX files
        const shouldAutoIndent = await vscode.window.showQuickPick(
          ['Yes', 'No'],
          {
            placeHolder: 'Auto-indent LaTeX files after download?',
            canPickMany: false,
          },
        );

        const autoIndent = shouldAutoIndent === 'Yes';

        // Show progress
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading arXiv Source',
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              logger.info(CHANNEL, 'User cancelled the download');
            });

            // Progress callback function
            const progressCallback = (message: string, increment?: number) => {
              progress.report({ message, increment });
            };

            // Download and extract source
            const extractedPath = await downloadArxivSource(
              arxivId,
              progressCallback,
              autoIndent,
            );

            // Show success message with a button to open the extracted folder
            const openFolderAction = 'Open Folder';
            const result = await vscode.window.showInformationMessage(
              `arXiv source downloaded and extracted to ${path.basename(extractedPath)}${
                autoIndent ? ' with LaTeX files indented' : ''
              }`,
              openFolderAction,
            );

            if (result === openFolderAction) {
              // Open the extracted folder in Explorer
              vscode.commands.executeCommand(
                'revealFileInOS',
                vscode.Uri.file(extractedPath),
              );
            }
          },
        );
      } catch (error) {
        if (error instanceof Error) {
          vscode.window.showErrorMessage(
            `Failed to download arXiv source: ${error.message}`,
          );
          logger.error(
            CHANNEL,
            `Error downloading arXiv source: ${error.message}`,
          );
        } else {
          vscode.window.showErrorMessage(
            'An unknown error occurred while downloading arXiv source',
          );
          logger.error(
            CHANNEL,
            `Unknown error downloading arXiv source: ${error}`,
          );
        }
      }
    },
  );

  context.subscriptions.push(downloadCommand);

  return {
    downloadArXivSource: downloadCommand,
  };
}
