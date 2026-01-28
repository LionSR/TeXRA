// Third-party imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports
import * as logger from '@logger/logUtils';
import { arxivProcessor } from '@latex/arxivProcessor';

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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      arXivCommands.downloadArXivSource,
      async () => {
        try {
          const arxivId = await vscode.window.showInputBox({
            placeHolder: 'e.g., 2404.12175 or https://arxiv.org/abs/2404.12175',
            prompt: 'Enter arXiv ID or URL',
            validateInput: arxivProcessor.validateId.bind(arxivProcessor),
          });

          if (!arxivId) {
            return;
          }

          const shouldAutoIndent = await vscode.window.showQuickPick(
            ['Yes', 'No'],
            {
              placeHolder: 'Auto-indent LaTeX files after download?',
              canPickMany: false,
            },
          );

          const autoIndent = shouldAutoIndent === 'Yes';
          let extractedPath = '';

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

              extractedPath = await arxivProcessor.downloadSource(
                arxivId,
                (message: string, increment?: number) => {
                  progress.report({ message, increment });
                },
                autoIndent,
              );
            },
          );

          const result = await vscode.window.showInformationMessage(
            `arXiv source downloaded to ${path.basename(extractedPath)}${
              autoIndent ? ' with LaTeX files indented' : ''
            }`,
            'Open Folder',
          );

          if (result === 'Open Folder') {
            void vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(extractedPath),
            );
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'An unknown error occurred';
          vscode.window.showErrorMessage(
            `Failed to download arXiv source: ${message}`,
          );
          logger.error(CHANNEL, `Error downloading arXiv source: ${message}`);
        }
      },
    ),
  );
}
