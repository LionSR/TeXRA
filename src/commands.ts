// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import * as logger from '@logger/logUtils';
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
import { registerSettingsViewCommands } from '@commands/settings';
import { registerAuthCommands } from '@commands/auth';
import { registerApiKeyCommands } from '@commands/api/apiKeyCommands';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerProgressViewCommands } from '@commands/progress/progressViewCommands';

// Local file imports
import { MainViewProvider } from './MainViewProvider';

const CHANNEL = 'Registration';
logger.initialize(CHANNEL);

// Store MainViewProvider instance for external access (e.g., auth state changes)
let mainViewProviderInstance: MainViewProvider | null = null;

/** Get the MainViewProvider instance (available after registerCommands is called). */
export function getMainViewProvider(): MainViewProvider | null {
  return mainViewProviderInstance;
}

/**
 * Register all extension commands
 * Commands are organized into logical groups in separate modules
 */
export function registerCommands(context: vscode.ExtensionContext): void {
  // Register command groups from separate modules
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

  // Register webview provider and store instance for external access
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

// Add exports for the command modules
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
