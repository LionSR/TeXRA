import * as vscode from 'vscode';

// Local imports - commands
import { registerFileSelectionCommands } from '@commands/files/fileSelectionCommands';
import { registerLatexdiffCommands } from '@commands/workspace/latex/latexdiffCommands';
import { registerGitCommands } from '@commands/workspace/git/gitCommands';
import { registerPackCommands } from './commands/workspace/packCommands';
import { registerCleanCommands } from './commands/workspace/cleanCommands';
import { registerMergeCommands } from './commands/workspace/mergeCommands';
import { registerExecuteCommand } from './commands/workspace/executeCommand';
import { TeXRAViewProvider } from './ViewProvider';
import { registerLatexCommands } from '@commands/workspace/latex/latexCommands';
import { registerImageCommands } from './commands/image/imageCommands';
import { registerFigureCommands } from './commands/fig/figCommands';
import { registerTestCommands } from './commands/workspace/testCommands';
import { registerXmlCommands } from './commands/workspace/xmlCommands';
import { registerYamlCommands } from './commands/workspace/yamlCommands';
import { registerAgentCommands } from './commands/agents/agentCommands';
import { registerAgentCreatorCommands } from '@commands/agents/agentCreatorCommands';
import { registerApiKeyCommands } from '@commands/api/apiKeyCommands';
import { registerStateRestoreCommand } from './commands/state/stateRestoreCommand';
import { registerTextEditorCommands } from './commands/text/textEditorCommands';
import { registerLinterCommands } from '@commands/workspace/latex/linterCommands';
import { registerWolframAlphaCommands } from '@commands/wolfram/wolframAlphaCommands';
import { registerWolframScriptCommands } from '@commands/wolfram/wolframScriptCommands';
import { registerHistoryCommands } from '@commands/history/historyCommands';
import { registerArXivCommands } from './commands/arXiv/arXivCommands';
import { registerCompareCommands } from './commands/compare/compareCommands';
import { registerHelpCommands } from './commands/help/helpCommands';
import { registerProgressViewCommands } from '@commands/progress/progressViewCommands';
import { registerOpenFileCommands } from '@commands/files/openFileCommands';
import { registerSettingsCommands } from './commands/settings/settingsCommands';

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
    settings: registerSettingsCommands(context),
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
export { latexdiffCommands } from '@commands/workspace/latex/latexdiffCommands';
export { gitCommands } from '@commands/workspace/git/gitCommands';
export { packCommands } from './commands/workspace/packCommands';
export { mergeCommands } from './commands/workspace/mergeCommands';
export { executeCommand } from './commands/workspace/executeCommand';
export { latexCommands } from '@commands/workspace/latex/latexCommands';
export { imageCommands } from './commands/image/imageCommands';
export { figureCommands } from './commands/fig/figCommands';
export { testCommands } from './commands/workspace/testCommands';
export { xmlCommands } from './commands/workspace/xmlCommands';
export { yamlCommands } from './commands/workspace/yamlCommands';
export { apiKeyCommands } from '@commands/api/apiKeyCommands';
export { stateRestoreCommand } from './commands/state/stateRestoreCommand';
export { textEditorCommands } from './commands/text/textEditorCommands';
export { linterCommands } from '@commands/workspace/latex/linterCommands';
export { wolframAlphaCommands } from '@commands/wolfram/wolframAlphaCommands';
export { wolframScriptCommands } from '@commands/wolfram/wolframScriptCommands';
export { historyCommands } from '@commands/history/historyCommands';
export { arXivCommands } from './commands/arXiv/arXivCommands';
export { compareCommands } from './commands/compare/compareCommands';
export { helpCommands } from './commands/help/helpCommands';
export { agentCreatorCommands } from '@commands/agents/agentCreatorCommands';
export { registerOpenFileCommands as openFileCommands } from '@commands/files/openFileCommands';
export { settingsCommands } from './commands/settings/settingsCommands';
