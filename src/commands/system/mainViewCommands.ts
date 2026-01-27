// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { computeAgentOptionsData, refresh } from '@agent/index';
import { toErrorMessage } from '@common/errors';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { computeModelOptionsData } from '@model/computeModelOptions';

const CHANNEL = 'mainViewCommands';

export const mainViewCommands = {
  reset: 'texra.mainView.reset',
  refreshModelOptions: 'texra.refreshModelOptions',
  refreshAgentOptions: 'texra.refreshAgentOptions',
  refreshAllOptions: 'texra.refreshAllOptions',
};

/**
 * Registers main view commands for the extension.
 */
export function registerMainViewCommands(
  context: vscode.ExtensionContext,
): void {
  const resetCommand = vscode.commands.registerCommand(
    mainViewCommands.reset,
    async () => {
      const webviewView = await getMainWebview(CHANNEL);
      if (!webviewView) {
        vscode.window.showWarningMessage(
          'Main view is not available. Please ensure the TeXRA view is open.',
        );
        return;
      }
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: {},
        isResetOperation: true,
      });
    },
  );

  /**
   * Refresh model options only in the webview.
   */
  const refreshModelOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshModelOptions,
    async () => {
      const webview = await getMainWebview(CHANNEL);
      if (!webview) return;

      try {
        const optionsData = await computeModelOptionsData();
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
          optionsData,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error(CHANNEL, `Failed to refresh model options: ${message}`);
        vscode.window.showErrorMessage(
          `Failed to refresh model options: ${message}`,
        );
      }
    },
  );

  /**
   * Refresh agent options only in the webview.
   */
  const refreshAgentOptionsCommand = vscode.commands.registerCommand(
    mainViewCommands.refreshAgentOptions,
    async () => {
      const webview = await getMainWebview(CHANNEL);
      if (!webview) return;

      try {
        await refresh();
        const optionsData = await computeAgentOptionsData();
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
          optionsData,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error(CHANNEL, `Failed to refresh agent options: ${message}`);
        vscode.window.showErrorMessage(
          `Failed to refresh agent options: ${message}`,
        );
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
      const webview = await getMainWebview(CHANNEL);
      if (!webview) return;

      try {
        await refresh();
        const [modelOptionsData, agentOptionsData] = await Promise.all([
          computeModelOptionsData(),
          computeAgentOptionsData(),
        ]);
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
          optionsData: modelOptionsData,
        });
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
          optionsData: agentOptionsData,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error(CHANNEL, `Failed to refresh options: ${message}`);
        vscode.window.showErrorMessage(`Failed to refresh options: ${message}`);
      }
    },
  );

  context.subscriptions.push(
    resetCommand,
    refreshModelOptionsCommand,
    refreshAgentOptionsCommand,
    refreshAllOptionsCommand,
  );
}
