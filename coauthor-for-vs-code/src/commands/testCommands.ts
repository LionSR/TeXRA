import * as vscode from 'vscode';
import * as logger from '../logger/logUtils';
import { handleTestConnection } from './tests/connectionTests';

const CHANNEL = 'TestCommands';
logger.initializeLogging(CHANNEL);

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
