// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { handleTestConnection } from '@commands/tests/connectionTests';

export function registerTestCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.testConnection',
      handleTestConnection,
    ),
  );
}
