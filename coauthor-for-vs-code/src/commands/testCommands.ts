// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports
import { handleTestConnection } from './tests/connectionTests';

const CHANNEL = 'Commands';
logger.initialize(CHANNEL);

export function registerTestCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.testConnection',
      handleTestConnection,
    ),
  );
  logger.debug(CHANNEL, 'Test commands registered');
}

export const testCommands = {
  handleTestConnection,
};
