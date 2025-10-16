import * as vscode from 'vscode';

// Local imports - commands
import { registerFileSelectionCommands } from '@commands/files/fileSelectionCommands';
import { registerLatexdiffCommands } from '@commands/latex/latexdiffCommands';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerPackCommands } from '@commands/housekeeping/packCommands';
import { registerCleanCommands } from '@commands/housekeeping/cleanCommands';
import { registerMergeCommands } from '@commands/agent/mergeCommands';
import { registerExecuteCommand } from '@commands/agent/executeCommand';
import { MainViewProvider } from './MainViewProvider';
import { registerLatexCommands } from '@commands/latex/latexCommands';
import { registerImageCommands } from '@commands/latex/imageCommands';
import { registerFigureCommands } from '@commands/latex/figCommands';
import { registerTestCommands } from '@commands/system/testCommands';
import { registerXmlCommands } from '@commands/system/xmlCommands';
import { registerYamlCommands } from '@commands/system/yamlCommands';
import { registerAgentCommands } from '@commands/agent/agentCommands';
import { registerAgentCreatorCommands } from '@commands/agent/agentCreatorCommands';
import { registerApiKeyCommands } from '@commands/api/apiKeyCommands';
import { registerStateRestoreCommand } from '@commands/history/stateRestoreCommand';
import { registerFollowUpCommand } from '@commands/agent/followUpCommand';
import { registerResumeAgentCommand } from '@commands/agent/resumeCommand';
import { registerTextEditorCommands } from '@commands/system/textEditorCommands';
import { registerLinterCommands } from '@commands/latex/linterCommands';
import { registerWolframScriptCommands } from '@commands/wolfram/wolframScriptCommands';
import { registerWolframToolCommands } from '@commands/wolfram/wolframToolCommands';
import { registerHistoryCommands } from '@commands/history/historyCommands';
import { registerArXivCommands } from '@commands/latex/arXivCommands';
import { registerCompareCommands } from '@commands/latex/compareCommands';
import { registerHelpCommands } from '@commands/system/helpCommands';
import { registerProgressViewCommands } from '@commands/progress/progressViewCommands';
import { registerOpenFileCommands } from '@commands/files/openFileCommands';
import { registerSettingsCommands } from '@commands/system/settingsCommands';
import { registerMainViewCommands } from '@commands/system/mainViewCommands';
import { registerSampleProjectCommands } from '@commands/system/sampleProjectCommands';
import { registerWalkthroughCommands } from '@commands/system/walkthroughCommands';

import * as logger from '@logger/logUtils';

const CHANNEL = 'Registration';
logger.initialize(CHANNEL);

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

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.mainView',
      new MainViewProvider(context),
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
export { fileSelectionCommands } from '@commands/files/fileSelectionCommands';
export { latexdiffCommands } from '@commands/latex/latexdiffCommands';
export { gitCommands } from '@commands/git/gitCommands';
export { packCommands } from '@commands/housekeeping/packCommands';
export { mergeCommands } from '@commands/agent/mergeCommands';
export { executeCommand } from '@commands/agent/executeCommand';
export { latexCommands } from '@commands/latex/latexCommands';
export { imageCommands } from '@commands/latex/imageCommands';
export { figureCommands } from '@commands/latex/figCommands';
export { testCommands } from '@commands/system/testCommands';
export { xmlCommands } from '@commands/system/xmlCommands';
export { yamlCommands } from '@commands/system/yamlCommands';
export { apiKeyCommands } from '@commands/api/apiKeyCommands';
export { stateRestoreCommand } from '@commands/history/stateRestoreCommand';
export { textEditorCommands } from '@commands/system/textEditorCommands';
export { linterCommands } from '@commands/latex/linterCommands';
export { wolframToolCommands } from '@commands/wolfram/wolframToolCommands';
export { wolframScriptCommands } from '@commands/wolfram/wolframScriptCommands';
export { historyCommands } from '@commands/history/historyCommands';
export { arXivCommands } from '@commands/latex/arXivCommands';
export { compareCommands } from '@commands/latex/compareCommands';
export { helpCommands } from '@commands/system/helpCommands';
export { agentCreatorCommands } from '@commands/agent/agentCreatorCommands';
export { registerOpenFileCommands as openFileCommands } from '@commands/files/openFileCommands';
export { settingsCommands } from '@commands/system/settingsCommands';
export { mainViewCommands } from '@commands/system/mainViewCommands';
export { sampleProjectCommands } from '@commands/system/sampleProjectCommands';
