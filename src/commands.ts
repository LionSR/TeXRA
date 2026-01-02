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
import {
  registerStateRestoreCommand,
  registerHistoryCommands,
} from '@commands/history';
import {
  registerWolframScriptCommands,
  registerWolframToolCommands,
} from '@commands/wolfram';
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
export function registerCommands(context: vscode.ExtensionContext) {
  // Register command groups from separate modules
  const registeredCommands = {
    fileSelection: registerFileSelectionCommands(context),
    latexdiff: registerLatexdiffCommands(context),
    git: registerGitCommands(context),
    pack: registerPackCommands(context),
    clean: registerCleanCommands(context),
    merge: registerMergeCommands(context),
    execute: registerExecuteCommand(context),
    latex: registerLatexCommands(context),
    image: registerImageCommands(context),
    figure: registerFigureCommands(context),
    test: registerTestCommands(context),
    xml: registerXmlCommands(context),
    yaml: registerYamlCommands(context),
    agent: registerAgentCommands(context),
    agentCreator: registerAgentCreatorCommands(context),
    apiKey: registerApiKeyCommands(context),
    auth: registerAuthCommands(context),
    stateRestore: registerStateRestoreCommand(context),
    textEditor: registerTextEditorCommands(context),
    linter: registerLinterCommands(context),
    wolframTool: registerWolframToolCommands(context),
    wolframScript: registerWolframScriptCommands(context),
    history: registerHistoryCommands(context),
    arXiv: registerArXivCommands(context),
    compare: registerCompareCommands(context),
    progressView: registerProgressViewCommands(context),
    followUp: registerFollowUpCommand(context),
    resumeAgent: registerResumeAgentCommand(context),
    openFile: registerOpenFileCommands(context),
    help: registerHelpCommands(context),
    mainView: registerMainViewCommands(context),
    settings: registerSettingsCommands(context),
    sampleProject: registerSampleProjectCommands(context),
    walkthrough: registerWalkthroughCommands(context),
  };

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

  return registeredCommands;
}

// Add exports for the command modules
export { fileSelectionCommands } from '@commands/files';
export {
  latexdiffCommands,
  latexCommands,
  imageCommands,
  figureCommands,
  linterCommands,
  arXivCommands,
  compareCommands,
} from '@commands/latex';
export { gitCommands } from '@commands/git/gitCommands';
export { packCommands } from '@commands/housekeeping';
export {
  mergeCommands,
  runExecuteCommand,
  agentCreatorCommands,
} from '@commands/agent';
export {
  testCommands,
  xmlCommands,
  yamlCommands,
  textEditorCommands,
  helpCommands,
  settingsCommands,
  mainViewCommands,
  sampleProjectCommands,
} from '@commands/system';
export { apiKeyCommands } from '@commands/api/apiKeyCommands';
export { stateRestoreCommand, historyCommands } from '@commands/history';
export { wolframToolCommands, wolframScriptCommands } from '@commands/wolfram';
export { openFileCommands } from '@commands/files';
