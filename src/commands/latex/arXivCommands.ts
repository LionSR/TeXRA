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
          const { arxivId, autoIndent } = await new Promise<{
            arxivId: string | undefined;
            autoIndent: boolean;
          }>((resolve) => {
            let settled = false;
            const inputBox = vscode.window.createInputBox();
            inputBox.placeholder =
              'e.g., 2404.12175 or https://arxiv.org/abs/2404.12175';
            inputBox.prompt = 'Enter arXiv ID or URL';
            inputBox.title = 'Download arXiv Source';

            const indentToggle: vscode.QuickInputButton = {
              iconPath: new vscode.ThemeIcon('indent'),
              tooltip: 'Auto-indent LaTeX files after download',
              toggle: { checked: true },
            };
            inputBox.buttons = [indentToggle];

            inputBox.onDidTriggerButton(() => {
              // Toggle state is managed automatically by VS Code
            });

            inputBox.onDidChangeValue((value) => {
              const error = arxivProcessor.validateId(value);
              inputBox.validationMessage = error ?? '';
            });

            inputBox.onDidAccept(() => {
              const value = inputBox.value;
              const error = arxivProcessor.validateId(value);
              if (error) {
                inputBox.validationMessage = error;
                return;
              }
              const checked = (indentToggle.toggle as { checked: boolean })
                .checked;
              settled = true;
              resolve({ arxivId: value, autoIndent: checked });
              inputBox.dispose();
            });

            inputBox.onDidHide(() => {
              inputBox.dispose();
              if (!settled) {
                resolve({ arxivId: undefined, autoIndent: false });
              }
            });

            inputBox.show();
          });

          if (!arxivId) {
            return;
          }
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
