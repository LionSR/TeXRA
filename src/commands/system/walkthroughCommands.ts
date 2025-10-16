// Third-party imports
import * as vscode from 'vscode';

export const walkthroughCommands = {
  openGettingStarted: 'texra.openGettingStarted',
};

export function registerWalkthroughCommands(context: vscode.ExtensionContext) {
  const openGettingStartedCommand = vscode.commands.registerCommand(
    walkthroughCommands.openGettingStarted,
    async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'texra.gettingStarted',
      );
    },
  );

  context.subscriptions.push(openGettingStartedCommand);

  return { openGettingStartedCommand };
}
