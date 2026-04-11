// Third-party imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports
import { toErrorMessage } from '@common/errors';
import {
  arxivProcessor,
  type ArxivDownloadDestination,
} from '@latex/arxivProcessor';
import * as logger from '@logger/logUtils';

const CHANNEL = 'arXivCommands';

// Command IDs
export const arXivCommands = {
  downloadArXivSource: 'texra.downloadArXivSource',
};

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

          const paperId = arxivProcessor.getPaperDirName(arxivId);

          const destinationPick = await vscode.window.showQuickPick(
            [
              {
                label: `References/${paperId}`,
                description: 'Download into References folder',
                value: 'references' as ArxivDownloadDestination,
              },
              {
                label: 'Workspace root',
                description: 'Download directly into the workspace root',
                value: 'root' as ArxivDownloadDestination,
              },
            ],
            {
              placeHolder: 'Where should the source be downloaded?',
              canPickMany: false,
            },
          );

          if (!destinationPick) {
            return;
          }

          const destination = destinationPick.value;

          // Auto-indent is not supported for root destination (would reformat all workspace files)
          const autoIndent =
            destination !== 'root' &&
            (await vscode.window.showQuickPick(['Yes', 'No'], {
              placeHolder: 'Auto-indent LaTeX files after download?',
              canPickMany: false,
            })) === 'Yes';
          const extractedPath = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Downloading arXiv Source',
              cancellable: true,
            },
            async (progress, token) => {
              token.onCancellationRequested(() => {
                logger.info(CHANNEL, 'User cancelled the download');
              });

              const downloadResult = await arxivProcessor.downloadSource(
                arxivId,
                {
                  progressCallback: (message, increment) =>
                    progress.report({ message, increment }),
                  autoIndent,
                  destination,
                },
              );
              return downloadResult.path;
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
          const message = toErrorMessage(error);
          vscode.window.showErrorMessage(
            `Failed to download arXiv source: ${message}`,
          );
          logger.error(CHANNEL, `Error downloading arXiv source: ${message}`);
        }
      },
    ),
  );
}
