// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { computeModelOptions } from '@model/computeModelOptions';
import { safeExecuteCommand } from '@frontend/system/commandUtils';

export const mainViewCommands = {
  reset: 'texra.mainView.reset',
  refreshModelOptions: 'texra.refreshModelOptions',
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

  const refreshModelOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshModelOptions,
    async () => {
      const webviewView = await safeExecuteCommand<vscode.WebviewView>(
        'texra.getWebviewView',
        [],
        'mainViewCommands',
      );
      if (webviewView) {
        try {
          const options = await computeModelOptions();
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
            options,
          });
        } catch (error) {
          console.error('Failed to refresh model options:', error);
          vscode.window.showErrorMessage(
            'Failed to refresh model options. Please check the output console for details.',
          );
        }
      }
    },
  );

  context.subscriptions.push(resetCommand, refreshModelOptionsCommand);

  return { resetCommand, refreshModelOptionsCommand };
}
