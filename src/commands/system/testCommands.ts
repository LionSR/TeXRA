// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';
import { handleTestConnection } from '@commands/tests/connectionTests';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export function registerTestCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.testConnection',
      handleTestConnection,
    ),
  );
}

export const testCommands = {
  handleTestConnection,
};
