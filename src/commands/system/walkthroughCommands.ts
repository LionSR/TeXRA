// Third-party imports
import * as vscode from 'vscode';

export function registerWalkthroughCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.openGettingStarted', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'texra.gettingStarted',
      ),
    ),
  );
}
