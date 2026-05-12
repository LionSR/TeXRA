// Third-party imports
import * as vscode from 'vscode';

const GETTING_STARTED_WALKTHROUGH_ID = 'texra.gettingStarted';

export function openGettingStarted(extensionId: string): Thenable<unknown> {
  return vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    `${extensionId}#${GETTING_STARTED_WALKTHROUGH_ID}`,
  );
}
