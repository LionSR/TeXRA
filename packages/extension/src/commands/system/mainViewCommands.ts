// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { computeAgentOptionsData, refresh } from '@agent/index';
import { arXivCommands } from '@commands/latex';
import { registerCommands } from '@commands/_shared/registerCommands';
import { gitCommands } from '@commands/git/gitCommands';
import { loadMainViewModelOptions } from '@frontend/agents/optionsLoader';
import { getMainWebview } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

import { sampleProjectCommands } from './sampleProjectCommands';

const CHANNEL = 'mainViewCommands';

const mainViewCommands = {
  reset: 'texra.mainView.reset',
  refreshModelOptions: 'texra.refreshModelOptions',
  refreshAgentOptions: 'texra.refreshAgentOptions',
  refreshAllOptions: 'texra.refreshAllOptions',
  showImportOptions: 'texra.showImportOptions',
};

type ModelOptionsByCategory = Awaited<
  ReturnType<typeof loadMainViewModelOptions>
>;
type AgentOptionsData = Awaited<ReturnType<typeof computeAgentOptionsData>>;
interface RefreshAllOptionsArgs {
  readonly selectedToolUseAgent?: string;
  readonly agentCatalogAlreadyFresh?: boolean;
}

function postModelOptions(
  webview: vscode.WebviewView,
  byCategory: ModelOptionsByCategory,
): void {
  webview.webview.postMessage({
    command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
    optionsData: byCategory.workflow,
    optionsDataByCategory: byCategory,
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
  registerCommands(context, [
    {
      id: mainViewCommands.refreshModelOptions,
      handler: () =>
        runRefresh('model options', async (webview) => {
          postModelOptions(webview, await loadMainViewModelOptions());
        }),
    },
    {
      id: mainViewCommands.refreshAgentOptions,
      handler: () =>
        runRefresh('agent options', async (webview) => {
          await refresh();
          postAgentOptions(webview, await computeAgentOptionsData());
        }),
    },
    {
      id: mainViewCommands.refreshAllOptions,
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
