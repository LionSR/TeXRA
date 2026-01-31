// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { refresh } from '@agent/index';
import { toErrorMessage } from '@common/errors';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';

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
  context.subscriptions.push(
    vscode.commands.registerCommand(mainViewCommands.reset, async () => {
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
    }),

    vscode.commands.registerCommand(
      mainViewCommands.refreshModelOptions,
      async () => {
        const webview = await getMainWebview(CHANNEL);
        if (!webview) return;

        await refresh();
        const options = await loadOptions((error) => {
          const message = toErrorMessage(error);
          logger.error(CHANNEL, `Failed to refresh model options: ${message}`);
          vscode.window.showErrorMessage(
            `Failed to refresh model options: ${message}`,
          );
        });
        if (!options) return;
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
          optionsData: options.modelOptions,
        });
      },
    ),

    vscode.commands.registerCommand(
      mainViewCommands.refreshAgentOptions,
      async () => {
        const webview = await getMainWebview(CHANNEL);
        if (!webview) return;

        await refresh();
        const options = await loadOptions((error) => {
          const message = toErrorMessage(error);
          logger.error(CHANNEL, `Failed to refresh agent options: ${message}`);
          vscode.window.showErrorMessage(
            `Failed to refresh agent options: ${message}`,
          );
        });
        if (!options) return;
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
          optionsData: options.agentOptions,
        });
      },
    ),

    vscode.commands.registerCommand(
      mainViewCommands.refreshAllOptions,
      async () => {
        const webview = await getMainWebview(CHANNEL);
        if (!webview) return;

        await refresh();
        const options = await loadOptions((error) => {
          const message = toErrorMessage(error);
          logger.error(CHANNEL, `Failed to refresh options: ${message}`);
          vscode.window.showErrorMessage(
            `Failed to refresh options: ${message}`,
          );
        });
        if (!options) return;
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
          optionsData: options.modelOptions,
        });
        webview.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
          optionsData: options.agentOptions,
        });
      },
    ),
  );
}
