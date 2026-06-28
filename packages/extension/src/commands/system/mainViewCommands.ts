// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { arXivCommands } from '@commands/latex';
import { registerCommands } from '@commands/_shared/registerCommands';
import { gitCommands } from '@commands/git/gitCommands';
import { toErrorMessage } from '@common/errors';
import { createExtensionMainViewStartupController } from '@frontend/agents/mainViewStartup';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';

import { sampleProjectCommands } from './sampleProjectCommands';

const CHANNEL = 'mainViewCommands';

const mainViewCommands = {
  reset: 'texra.mainView.reset',
  refreshModelOptions: 'texra.refreshModelOptions',
  refreshAgentOptions: 'texra.refreshAgentOptions',
  refreshAllOptions: 'texra.refreshAllOptions',
  showImportOptions: 'texra.showImportOptions',
};

/**
 * Registers main view commands for the extension.
 *
 * `texra.mainView.reset` and `texra.showImportOptions` are now registered
 * through the shared command registry in `extensionCommandSurface.ts`.
 */
export function registerMainViewCommands(
  context: vscode.ExtensionContext,
): void {
  const startupController = createExtensionMainViewStartupController();
  registerCommands(context, [
    {
      id: mainViewCommands.refreshModelOptions,
      handler: async () => {
        const webview = await getMainWebview(CHANNEL);
        if (!webview) return;

        try {
          webview.webview.postMessage(
            await startupController.getModelOptionsRefreshMessage(),
          );
        } catch (error) {
          const message = toErrorMessage(error);
          logger.error(CHANNEL, `Failed to refresh model options: ${message}`);
          vscode.window.showErrorMessage(
            `Failed to refresh model options: ${message}`,
          );
        }
      },
    },
    {
      id: mainViewCommands.refreshAgentOptions,
      handler: async () => {
        const webview = await getMainWebview(CHANNEL);
        if (!webview) return;

        try {
          webview.webview.postMessage(
            await startupController.getAgentOptionsRefreshMessage(),
          );
        } catch (error) {
          const message = toErrorMessage(error);
          logger.error(CHANNEL, `Failed to refresh agent options: ${message}`);
          vscode.window.showErrorMessage(
            `Failed to refresh agent options: ${message}`,
          );
        }
      },
    },
    {
      id: mainViewCommands.refreshAllOptions,
      handler: async () => {
        const webview = await getMainWebview(CHANNEL);
        if (!webview) return;

        try {
          const messages =
            await startupController.getAllOptionsRefreshMessages();
          for (const message of messages) {
            webview.webview.postMessage(message);
          }
        } catch (error) {
          const message = toErrorMessage(error);
          logger.error(CHANNEL, `Failed to refresh options: ${message}`);
          vscode.window.showErrorMessage(
            `Failed to refresh options: ${message}`,
          );
        }
      },
    },
  ]);
}

/**
 * Show the project import quick-pick. Migrated to the shared command
 * registry in #3781 batch 4.
 */
export async function showImportOptions(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(repo-clone) Pull from Overleaf',
        description: 'Import an existing Overleaf/ShareLaTeX project',
        command: gitCommands.cloneOverleafProject,
      },
      {
        label: '$(cloud-download) Grab from arXiv',
        description: "Download a paper's source files",
        command: arXivCommands.downloadArXivSource,
      },
      {
        label: '$(file-add) Try the sample project',
        description: 'Create a sample project to play around risk-free',
        command: sampleProjectCommands.createSampleProject,
      },
      {
        label: '$(rocket) Run the setup assistant agent',
        description: 'Check tools, credentials, and LaTeX setup',
        command: 'texra.runSetupAssistant',
      },
      {
        label: '$(book) Walk me through setup',
        description: 'Open the getting started walkthrough',
        command: 'texra.openGettingStarted',
      },
    ],
    { placeHolder: 'Import or create a LaTeX project' },
  );
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}
