// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { computeAgentOptions } from '@agent/index';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { computeModelOptions } from '@model/computeModelOptions';

const CHANNEL = 'mainViewCommands';

export const mainViewCommands = {
  reset: 'texra.mainView.reset',
  refreshModelOptions: 'texra.refreshModelOptions',
  refreshAllOptions: 'texra.refreshAllOptions',
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

  /**
   * Refresh both model and agent options in the webview.
   * This is the primary command for refreshing dropdown options.
   */
  const refreshAllOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshAllOptions,
    async () => {
      const webviewView = await safeExecuteCommand<vscode.WebviewView>(
        'texra.getWebviewView',
        [],
        'mainViewCommands',
      );
      if (webviewView) {
        try {
          // Refresh both model and agent options in parallel
          const [modelOptions, agentOptions] = await Promise.all([
            computeModelOptions(),
            computeAgentOptions(),
          ]);

          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
            options: modelOptions,
          });

          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
            options: agentOptions,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(CHANNEL, `Failed to refresh options: ${message}`);
          vscode.window.showErrorMessage(
            'Failed to refresh options. Please check the output console for details.',
          );
        }
      }
    },
  );

  /**
   * Legacy command for refreshing model options only.
   * Now delegates to refreshAllOptions for consistency.
   * @deprecated Use refreshAllOptions instead
   */
  const refreshModelOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshModelOptions,
    async () => {
      // Delegate to refreshAllOptions for consistent behavior
      await vscode.commands.executeCommand(mainViewCommands.refreshAllOptions);
    },
  );

  context.subscriptions.push(
    resetCommand,
    refreshAllOptionsCommand,
    refreshModelOptionsCommand,
  );

  return { resetCommand, refreshAllOptionsCommand, refreshModelOptionsCommand };
}
