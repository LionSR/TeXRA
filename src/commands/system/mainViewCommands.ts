// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { computeAgentOptions, refresh } from '@agent/index';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { computeModelOptions } from '@model/computeModelOptions';

const CHANNEL = 'mainViewCommands';

export const mainViewCommands = {
  reset: 'texra.mainView.reset',
  refreshModelOptions: 'texra.refreshModelOptions',
  refreshAgentOptions: 'texra.refreshAgentOptions',
  refreshAllOptions: 'texra.refreshAllOptions',
};

/**
 * Get the main webview view instance.
 */
async function getMainWebview(): Promise<vscode.WebviewView | undefined> {
  return safeExecuteCommand<vscode.WebviewView>(
    'texra.getWebviewView',
    [],
    CHANNEL,
  );
}

/**
 * Log a refresh error and notify the user.
 */
function logRefreshError(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(CHANNEL, `Failed to ${context}: ${message}`);
  vscode.window.showErrorMessage(`Failed to ${context}: ${message}`);
}

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
   * Refresh model options only in the webview.
   */
  const refreshModelOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshModelOptions,
    async () => {
      const webview = await getMainWebview();
      if (!webview) return;

      try {
        const options = await computeModelOptions();
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
          options,
        });
      } catch (error) {
        logRefreshError(error, 'refresh model options');
      }
    },
  );

  /**
   * Refresh agent options only in the webview.
   */
  const refreshAgentOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshAgentOptions,
    async () => {
      const webview = await getMainWebview();
      if (!webview) return;

      try {
        // Reload agent index to pick up config changes
        await refresh();
        const options = await computeAgentOptions();
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
          options,
        });
      } catch (error) {
        logRefreshError(error, 'refresh agent options');
      }
    },
  );

  /**
   * Refresh both model and agent options in the webview.
   * Used when both need to be updated together (e.g., API key changes, auth changes).
   */
  const refreshAllOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshAllOptions,
    async () => {
      const webview = await getMainWebview();
      if (!webview) return;

      try {
        // Reload agent index first, then compute both in parallel
        await refresh();
        const [modelOptions, agentOptions] = await Promise.all([
          computeModelOptions(),
          computeAgentOptions(),
        ]);

        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
          options: modelOptions,
        });
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
          options: agentOptions,
        });
      } catch (error) {
        logRefreshError(error, 'refresh options');
      }
    },
  );

  context.subscriptions.push(
    resetCommand,
    refreshModelOptionsCommand,
    refreshAgentOptionsCommand,
    refreshAllOptionsCommand,
  );

  return {
    resetCommand,
    refreshModelOptionsCommand,
    refreshAgentOptionsCommand,
    refreshAllOptionsCommand,
  };
}
