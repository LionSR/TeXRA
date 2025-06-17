import * as vscode from 'vscode';

// Local imports - commands
import { registerFileSelectionCommands } from '@commands/files/fileSelectionCommands';
import { registerLatexdiffCommands } from '@commands/latex/latexdiffCommands';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerPackCommands } from './commands/packCommands';
import { registerCleanCommands } from './commands/cleanCommands';
import { registerMergeCommands } from './commands/mergeCommands';
import { registerExecuteCommand } from './commands/executeCommand';
import { TeXRAViewProvider } from './ViewProvider';
import { registerLatexCommands } from '@commands/latex/latexCommands';
import { registerImageCommands } from './commands/imageCommands';
import { registerFigureCommands } from './commands/figCommands';
import { registerTestCommands } from './commands/testCommands';
import { registerXmlCommands } from './commands/xmlCommands';
import { registerYamlCommands } from './commands/yamlCommands';
import { registerAgentCommands } from './commands/agentCommands';
import { registerAgentCreatorCommands } from '@commands/agentCreatorCommands';
import { registerApiKeyCommands } from '@commands/api/apiKeyCommands';
import { registerStateRestoreCommand } from './commands/stateRestoreCommand';
import { registerTextEditorCommands } from './commands/textEditorCommands';
import { registerLinterCommands } from '@commands/latex/linterCommands';
import { registerWolframAlphaCommands } from '@commands/wolfram/wolframAlphaCommands';
import { registerWolframScriptCommands } from '@commands/wolfram/wolframScriptCommands';
import { registerHistoryCommands } from '@commands/history/historyCommands';
import { registerArXivCommands } from './commands/arXivCommands';
import { registerCompareCommands } from './commands/compareCommands';
import { registerHelpCommands } from './commands/helpCommands';
import { registerProgressViewCommands } from '@commands/progress/progressViewCommands';
import { registerOpenFileCommands } from '@commands/files/openFileCommands';

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
    wolframAlpha: registerWolframAlphaCommands(context),
    wolframScript: registerWolframScriptCommands(context),
    history: registerHistoryCommands(context),
    arXiv: registerArXivCommands(context),
    compare: registerCompareCommands(context),
    progressView: registerProgressViewCommands(context),
    openFile: registerOpenFileCommands(context),
    help: registerHelpCommands(context),
  };

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.mainView',
      new TeXRAViewProvider(context),
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
export { packCommands } from './commands/packCommands';
export { mergeCommands } from './commands/mergeCommands';
export { executeCommand } from './commands/executeCommand';
export { latexCommands } from '@commands/latex/latexCommands';
export { imageCommands } from './commands/imageCommands';
export { figureCommands } from './commands/figCommands';
export { testCommands } from './commands/testCommands';
export { xmlCommands } from './commands/xmlCommands';
export { yamlCommands } from './commands/yamlCommands';
export { apiKeyCommands } from '@commands/api/apiKeyCommands';
export { stateRestoreCommand } from './commands/stateRestoreCommand';
export { textEditorCommands } from './commands/textEditorCommands';
export { linterCommands } from '@commands/latex/linterCommands';
export { wolframAlphaCommands } from '@commands/wolfram/wolframAlphaCommands';
export { wolframScriptCommands } from '@commands/wolfram/wolframScriptCommands';
export { historyCommands } from '@commands/history/historyCommands';
export { arXivCommands } from './commands/arXivCommands';
export { compareCommands } from './commands/compareCommands';
export { helpCommands } from './commands/helpCommands';
export { agentCreatorCommands } from '@commands/agentCreatorCommands';
export { registerOpenFileCommands as openFileCommands } from '@commands/files/openFileCommands';
