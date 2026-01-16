// Third-party imports
import * as vscode from 'vscode';

export const walkthroughCommands = {
  openGettingStarted: 'texra.openGettingStarted',
};

export function registerWalkthroughCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      walkthroughCommands.openGettingStarted,
      () =>
        vscode.commands.executeCommand(
          'workbench.action.openWalkthrough',
          'texra.gettingStarted',
        ),
    ),
  );
}
