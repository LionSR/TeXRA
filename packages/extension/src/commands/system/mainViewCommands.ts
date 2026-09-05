// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';

const CHANNEL = 'mainViewCommands';

interface RefreshAllOptionsArgs {
  readonly selectedToolUseAgent?: string;
  readonly agentCatalogAlreadyFresh?: boolean;
}

/**
 * Registers main view commands for the extension.
 *
 * `texra.mainView.reset` and `texra.showImportOptions` are registered
 * through the shared command registry in `extensionCommandSurface.ts`.
 */
export function registerMainViewCommands(
  context: vscode.ExtensionContext,
  progressViewProvider: ProgressViewProvider,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.refreshAllOptions',
      handler: async (args?: RefreshAllOptionsArgs) => {
        try {
          await progressViewProvider.refreshCatalogs(args ?? {});
        } catch (error) {
          await showLoggedErrorMessage(
            CHANNEL,
            'Failed to refresh options',
            error,
          );
        }
      },
    },
  ]);
}

/** Show the project import quick-pick. */
export async function showImportOptions(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(repo-clone) Pull from Overleaf',
        description: 'Import an existing Overleaf/ShareLaTeX project',
        command: EXTENSION_COMMANDS.CLONE_OVERLEAF_PROJECT,
      },
      {
        label: '$(cloud-download) Grab from arXiv',
        description: "Download a paper's source files",
        command: EXTENSION_COMMANDS.DOWNLOAD_ARXIV_SOURCE,
      },
      {
        label: '$(file-add) Try the sample project',
        description: 'Create a sample project to play around risk-free',
        command: EXTENSION_COMMANDS.CREATE_SAMPLE_PROJECT,
      },
      {
        label: '$(rocket) Run the setup assistant',
        description: 'Check tools, credentials, and LaTeX setup',
        command: EXTENSION_COMMANDS.RUN_SETUP_ASSISTANT,
      },
      {
        label: '$(book) Walk me through setup',
        description: 'Open the getting started walkthrough',
        command: EXTENSION_COMMANDS.OPEN_GETTING_STARTED,
      },
    ],
    { placeHolder: 'Import or create a LaTeX project' },
  );
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}
