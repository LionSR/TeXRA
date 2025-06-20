import * as vscode from 'vscode';

// Local imports - commands
import { registerFileSelectionCommands } from '@commands/files/fileSelectionCommands';
import { registerLatexdiffCommands } from '@commands/latex/latexdiffCommands';
import { registerGitCommands } from '@commands/integrations/git/gitCommands';
import { registerPackCommands } from './commands/workspace/packCommands';
import { registerCleanCommands } from './commands/workspace/cleanCommands';
import { registerMergeCommands } from './commands/workspace/mergeCommands';
import { registerExecuteCommand } from './commands/agent/executeCommand';
import { TeXRAViewProvider } from './ViewProvider';
import { registerLatexCommands } from '@commands/latex/latexCommands';
import { registerImageCommands } from './commands/latex/imageCommands';
import { registerFigureCommands } from './commands/latex/figCommands';
import { registerTestCommands } from './commands/tests/testCommands';
import { registerXmlCommands } from './commands/workspace/xmlCommands';
import { registerYamlCommands } from './commands/workspace/yamlCommands';
import { registerAgentCommands } from './commands/agent/agentCommands';
import { registerAgentCreatorCommands } from '@commands/agent/agentCreatorCommands';
import { registerApiKeyCommands } from '@commands/integrations/apiKeyCommands';
import { registerStateRestoreCommand } from './commands/utils/stateRestoreCommand';
import { registerTextEditorCommands } from './commands/utils/textEditorCommands';
import { registerLinterCommands } from '@commands/latex/linterCommands';
import { registerWolframAlphaCommands } from '@commands/integrations/wolfram/wolframAlphaCommands';
import { registerWolframScriptCommands } from '@commands/integrations/wolfram/wolframScriptCommands';
import { registerHistoryCommands } from '@commands/views/history/historyCommands';
import { registerArXivCommands } from './commands/integrations/arXivCommands';
import { registerCompareCommands } from './commands/utils/compareCommands';
import { registerHelpCommands } from './commands/utils/helpCommands';
import { registerProgressViewCommands } from '@commands/views/progressViewCommands';
import { registerOpenFileCommands } from '@commands/files/openFileCommands';
import { registerSettingsCommands } from './commands/utils/settingsCommands';

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
export { latexdiffCommands } from '@commands/latex/latexdiffCommands';
export { gitCommands } from '@commands/integrations/git/gitCommands';
export { packCommands } from './commands/workspace/packCommands';
export { mergeCommands } from './commands/workspace/mergeCommands';
export { executeCommand } from './commands/agent/executeCommand';
export { latexCommands } from '@commands/latex/latexCommands';
export { imageCommands } from './commands/latex/imageCommands';
export { figureCommands } from './commands/latex/figCommands';
export { testCommands } from './commands/tests/testCommands';
export { xmlCommands } from './commands/workspace/xmlCommands';
export { yamlCommands } from './commands/workspace/yamlCommands';
export { apiKeyCommands } from '@commands/integrations/apiKeyCommands';
export { stateRestoreCommand } from './commands/utils/stateRestoreCommand';
export { textEditorCommands } from './commands/utils/textEditorCommands';
export { linterCommands } from '@commands/latex/linterCommands';
export { wolframAlphaCommands } from '@commands/integrations/wolfram/wolframAlphaCommands';
export { wolframScriptCommands } from '@commands/integrations/wolfram/wolframScriptCommands';
export { historyCommands } from '@commands/views/history/historyCommands';
export { arXivCommands } from './commands/integrations/arXivCommands';
export { compareCommands } from './commands/utils/compareCommands';
export { helpCommands } from './commands/utils/helpCommands';
export { agentCreatorCommands } from '@commands/agent/agentCreatorCommands';
export { registerOpenFileCommands as openFileCommands } from '@commands/files/openFileCommands';
export { settingsCommands } from './commands/utils/settingsCommands';
