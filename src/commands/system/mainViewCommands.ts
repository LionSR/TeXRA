// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
// Local imports - utilities
import { safeExecuteCommand } from '@utils/system';

export const mainViewCommands = {
  reset: 'texra.mainView.reset',
};

/**
 * Registers main view commands for the extension
 * @param context - The VS Code extension context
 * @returns Object containing the registered commands
 */
export function registerMainViewCommands(context: vscode.ExtensionContext) {
  const resetCommand = vscode.commands.registerCommand(
    mainViewCommands.reset,
    async () => {
      const webviewView = await safeExecuteCommand<vscode.WebviewView>(
        'texra.getWebviewView',
        [],
        'mainViewCommands',
      );

      if (webviewView) {
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
          state: {},
        });
      } else {
        // Log warning when webview is not available
        vscode.window.showWarningMessage(
          'Main view is not available. Please ensure the TeXRA view is open.',
        );
      }
    },
  );

  context.subscriptions.push(resetCommand);

  return { resetCommand };
}
