// Third-party imports
import * as vscode from 'vscode';

const GETTING_STARTED_WALKTHROUGH_ID = 'texra-ai.texra#texra.gettingStarted';

export function registerWalkthroughCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.openGettingStarted', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        GETTING_STARTED_WALKTHROUGH_ID,
      ),
    ),
  );
}
