// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import {
  registerFileSelectionCommands,
  registerOpenFileCommands,
} from '@commands/files';
import {
  registerLatexdiffCommands,
  registerLatexCommands,
  registerImageCommands,
  registerFigureCommands,
  registerLinterCommands,
  registerArXivCommands,
  registerCompareCommands,
} from '@commands/latex';
import {
  registerPackCommands,
  registerCleanCommands,
} from '@commands/housekeeping';
import {
  registerMergeCommands,
  registerExecuteCommand,
  registerAgentCommands,
  registerAgentCreatorCommands,
  registerFollowUpCommand,
  registerResumeAgentCommand,
} from '@commands/agent';
import {
  registerTestCommands,
  registerXmlCommands,
  registerYamlCommands,
  registerTextEditorCommands,
  registerHelpCommands,
  registerSettingsCommands,
  registerMainViewCommands,
  registerSampleProjectCommands,
  registerWalkthroughCommands,
} from '@commands/system';
import { registerStateRestoreCommand } from '@commands/history';
import {
  registerSettingsViewCommands,
  initializeSettingsViewProvider,
} from '@commands/settings';
import { registerAuthCommands } from '@commands/auth';
import { registerSetupAssistantCommand } from '@commands/setup';
import { registerApiKeyCommands } from '@commands/api/apiKeyCommands';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerProgressViewCommands } from '@commands/progress/progressViewCommands';
import {
  createExtensionCommandActions,
  registerExtensionCommandRegistry,
} from '@commands/extensionCommandSurface';

// Local file imports
import { MainViewProvider } from './MainViewProvider';

let mainViewProviderInstance: MainViewProvider | null = null;

export function getMainViewProvider(): MainViewProvider | null {
  return mainViewProviderInstance;
}

export function registerCommands(context: vscode.ExtensionContext): void {
  registerFileSelectionCommands(context);
  registerLatexdiffCommands(context);
  registerGitCommands(context);
  registerPackCommands(context);
  registerCleanCommands(context);
  registerMergeCommands(context);
  registerExecuteCommand(context);
  registerLatexCommands(context);
  registerImageCommands(context);
  registerFigureCommands(context);
  registerTestCommands(context);
  registerXmlCommands(context);
  registerYamlCommands(context);
  registerAgentCommands(context);
  registerAgentCreatorCommands(context);
  registerApiKeyCommands(context);
  registerAuthCommands(context);
  registerStateRestoreCommand(context);
  registerTextEditorCommands(context);
  registerLinterCommands(context);
  registerSettingsViewCommands(context);
  registerArXivCommands(context);
  registerCompareCommands(context);
  registerProgressViewCommands(context);
  registerFollowUpCommand(context);
  registerResumeAgentCommand(context);
  registerOpenFileCommands(context);
  registerHelpCommands(context);
  registerMainViewCommands(context);
  registerSettingsCommands(context);
  registerSampleProjectCommands(context);
  registerWalkthroughCommands(context);
  registerSetupAssistantCommand(context);

  // Settings tab routes, workbench-settings shortcut, and main-view reset
  // share their dispatch shape with the desktop registry, so they're
  // registered through the shared `dispatchCommandFromRegistry` helper
  // rather than per-command `registerCommand` call sites. The remaining
  // commands stay on the per-command pattern for now (tracked in #3693).
  const settingsViewProvider = initializeSettingsViewProvider(context);
  registerExtensionCommandRegistry(
    context,
    createExtensionCommandActions(settingsViewProvider),
  );

  mainViewProviderInstance = new MainViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.mainView',
      mainViewProviderInstance,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );
}

export { linterCommands, arXivCommands } from '@commands/latex';
export { runExecuteCommand, agentCreatorCommands } from '@commands/agent';
export {
  xmlCommands,
  yamlCommands,
  helpCommands,
  settingsCommands,
  mainViewCommands,
  sampleProjectCommands,
} from '@commands/system';
export { apiKeyCommands } from '@commands/api/apiKeyCommands';
export { historyCommands } from '@commands/history';
export { settingsViewCommands } from '@commands/settings';
