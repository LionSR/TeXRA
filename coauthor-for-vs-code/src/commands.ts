import * as vscode from 'vscode';

// Local imports - commands
import { registerFileSelectionCommands } from './commands/fileSelectionCommands';
import { registerLatexdiffCommands } from './commands/latexdiffCommmands';
import { registerGitCommands } from './commands/gitCommands';
import { registerPackCommands } from './commands/packCommands';
import { registerMergeCommands } from './commands/mergeCommands';
import { registerExecuteCommand } from './commands/executeCommand';
import { CoAuthorViewProvider } from './ViewProvider';
import { registerLatexCommands } from './commands/latexCommands';
import { registerImageCommands } from './commands/imageCommands';
import { registerFigureCommands } from './commands/figCommands';
import { registerTestCommands } from './commands/testCommands';
import { registerXmlCommands } from './commands/xmlCommands';
import { registerYamlCommands } from './commands/yamlCommands';
import { registerAgentCommands } from './commands/agentCommands';

import * as logger from './logger/logUtils';

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
    merge: registerMergeCommands(context),
    execute: registerExecuteCommand(context),
    latex: registerLatexCommands(context),
    image: registerImageCommands(context),
    figure: registerFigureCommands(context),
    test: registerTestCommands(context),
    xml: registerXmlCommands(context),
    yaml: registerYamlCommands(context),
    agent: registerAgentCommands(context),
  };

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'coauthor.chatView',
      new CoAuthorViewProvider(context),
    ),
  );

  return registeredCommands;
}

// Add exports for the command modules
export { fileSelectionCommands } from './commands/fileSelectionCommands';
export { latexdiffCommands } from './commands/latexdiffCommmands';
export { gitCommands } from './commands/gitCommands';
export { packCommands } from './commands/packCommands';
export { mergeCommands } from './commands/mergeCommands';
export { executeCommand } from './commands/executeCommand';
export { latexCommands } from './commands/latexCommands';
export { imageCommands } from './commands/imageCommands';
export { figureCommands } from './commands/figCommands';
export { testCommands } from './commands/testCommands';
export { xmlCommands } from './commands/xmlCommands';
export { yamlCommands } from './commands/yamlCommands';
