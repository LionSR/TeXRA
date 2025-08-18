// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
// Local imports - utilities
import { safeExecuteCommand } from '@utils/system';

export const mainViewCommands = {
  reset: 'texra.mainView.reset',
};

export function registerMainViewCommands(context: vscode.ExtensionContext) {
  const resetCommand = vscode.commands.registerCommand(
    mainViewCommands.reset,
    async () => {
      const webviewView = await safeExecuteCommand<vscode.WebviewView>(
        'texra.getWebviewView',
        [],
        'mainViewCommands',
      );

      webviewView?.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: {},
      });
    },
  );

  context.subscriptions.push(resetCommand);

  return { resetCommand };
}
