// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { computeAgentOptionsData, refresh } from '@agent/index';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import {
  loadMainViewModelOptions,
  type MainViewModelOptionsByCategory,
} from '@frontend/agents/optionsLoader';
import { loadMainViewTeamOptions } from '@frontend/agents/teamOptionsLoader';
import { getMainWebview } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

const CHANNEL = 'mainViewCommands';

type AgentOptionsData = Awaited<ReturnType<typeof computeAgentOptionsData>>;
interface RefreshAllOptionsArgs {
  readonly selectedToolUseAgent?: string;
  readonly agentCatalogAlreadyFresh?: boolean;
}

function postModelOptions(
  webview: vscode.WebviewView,
  optionsDataByCategory: MainViewModelOptionsByCategory,
): void {
  webview.webview.postMessage({
    command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
    optionsDataByCategory,
  });
}

function postAgentOptions(
  webview: vscode.WebviewView,
  optionsData: AgentOptionsData,
  selectedToolUseAgent?: string,
): void {
  webview.webview.postMessage({
    command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
    optionsData,
    ...(selectedToolUseAgent && { selectedToolUseAgent }),
  });
}

async function postTeamOptions(webview: vscode.WebviewView): Promise<void> {
  webview.webview.postMessage({
    command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
    optionsData: await loadMainViewTeamOptions(),
  });
}

async function runRefresh(
  label: string,
  apply: (webview: vscode.WebviewView) => Promise<void>,
): Promise<void> {
  const webview = await getMainWebview(CHANNEL);
  if (!webview) return;

  try {
    await apply(webview);
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, `Failed to refresh ${label}`, error);
  }
}

/**
 * Registers main view commands for the extension.
 *
 * `texra.mainView.reset` and `texra.showImportOptions` are now registered
 * through the shared command registry in `extensionCommandSurface.ts`.
 */
export function registerMainViewCommands(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.refreshAllOptions',
      handler: (args?: RefreshAllOptionsArgs) =>
        runRefresh('options', async (webview) => {
          if (!args?.agentCatalogAlreadyFresh) await refresh();
          const [modelOptionsByCategory, agentOptionsData] = await Promise.all([
            loadMainViewModelOptions(),
            computeAgentOptionsData(),
          ]);
          postModelOptions(webview, modelOptionsByCategory);
          postAgentOptions(
            webview,
            agentOptionsData,
            args?.selectedToolUseAgent,
          );
          await postTeamOptions(webview);
        }),
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
