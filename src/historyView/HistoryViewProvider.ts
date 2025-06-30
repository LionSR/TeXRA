import * as vscode from 'vscode';
import { AgentHistoryManager } from './AgentHistoryManager';
import { executeCommand } from '@commands/agent/executeCommand';
import { agentConfigToTaskState } from '@utils/config';
import { showLoggedErrorMessage } from '@utils/errorHandlingUtils';
// @ts-ignore - Import JavaScript module
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { HistoryViewContentProvider } from './HistoryViewContentProvider';
import * as logger from '@logger/logUtils';

const CHANNEL = 'HistoryViewProvider';
logger.initialize(CHANNEL);

export class HistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'texra.historyView';
  private _view?: vscode.WebviewPanel;
  private readonly contentProvider: HistoryViewContentProvider;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.contentProvider = new HistoryViewContentProvider(context);
  }

  /**
   * This is required for the WebviewViewProvider interface but we won't use it
   * as we're removing the sidebar integration
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // We no longer use webview in the sidebar, but we need this method for the interface
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showHistoryView() {
    // If we already have a panel, show it
    if (this._view) {
      this._view.reveal(vscode.ViewColumn.One);
      return;
    }

    // Otherwise, create a new panel
    this._view = vscode.window.createWebviewPanel(
      HistoryViewProvider.viewType,
      'TeXRA History',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'src', 'historyView'),
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'src',
            'common',
            'styles',
          ),
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'src',
            'common',
            'modules',
          ),
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'node_modules',
            '@vscode',
            'codicons',
            'dist',
          ),
        ],
      },
    );

    // Handle webview disposal
    this._view.onDidDispose(() => {
      this._view = undefined;
    });

    // Handle messages from the webview
    this._view.webview.onDidReceiveMessage(async (message) => {
      await this.handleWebviewMessage(message);
    });

    // Set initial HTML content
    await this.updateWebviewContent();
  }

  /**
   * Handle messages from the webview
   */
  private handlers: Record<string, (message: any) => Promise<void> | void> = {
    [HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA]: () => this.sendHistoryData(),
    [HISTORY_VIEW_COMMANDS.RERUN_AGENT]: (m: any) =>
      this.rerunAgent(m.historyId),
    [HISTORY_VIEW_COMMANDS.RESTORE_AGENT]: (m: any) =>
      this.restoreAgent(m.historyId),
    [HISTORY_VIEW_COMMANDS.DELETE_AGENT]: (m: any) =>
      this.deleteHistoryItem(m.historyId),
    [HISTORY_VIEW_COMMANDS.CLEAR_HISTORY]: () => this.clearHistory(),
  };

  private async handleWebviewMessage(message: any) {
    const handler = this.handlers[message.command];
    if (handler) {
      await handler(message);
    }
  }

  /**
   * Send history data to the webview
   */
  private async sendHistoryData() {
    const history = await AgentHistoryManager.getHistory();

    // Send data to the webview
    if (this._view) {
      this._view.webview.postMessage({
        command: HISTORY_VIEW_COMMANDS.UPDATE_HISTORY,
        historyItems: history,
      });
    }
  }

  /**
   * Update the content of the webview
   */
  private async updateWebviewContent() {
    if (this._view) {
      this._view.webview.html = this.contentProvider.getHtmlContent(
        this._view.webview,
      );

      // Send history data after a short delay to ensure the webview is ready
      setTimeout(() => this.sendHistoryData(), 100);
    }
  }

  /**
   * Rerun an agent with the configuration from history
   */
  private async rerunAgent(historyId: string) {
    try {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(historyId);

      if (historyItem) {
        // Check: do we need to send a taskID or is it included in the config?
        vscode.window.showInformationMessage(`Rerunning agent from history`);
        await executeCommand.executeCommand(historyItem.config, this.context);
      } else {
        vscode.window.showErrorMessage(`History item not found`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to rerun agent: ${error}`);
    }
  }

  /**
   * Restore an agent configuration from history to the main view
   */
  private async restoreAgent(historyId: string) {
    try {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(historyId);

      if (historyItem) {
        logger.debug(
          CHANNEL,
          `Restoring configuration from history item: ${historyId}`,
        );

        const config = historyItem.config;

        // Convert from AgentConfig to TaskState format using the utility function
        // This ensures all fields including UI visibility flags are properly set
        const taskState = agentConfigToTaskState(config);

        // Log the converted taskState for debugging
        logger.debug(
          CHANNEL,
          `Converted taskState: ${JSON.stringify(taskState)}`,
        );

        // Send the properly formatted taskState to the restoreState command
        await vscode.commands.executeCommand('texra.restoreState', taskState);

        // vscode.window.showInformationMessage(
        //   `Configuration restored to main view`,
        // );
      } else {
        vscode.window.showErrorMessage(`History item not found`);
      }
    } catch (error) {
      await showLoggedErrorMessage(
        CHANNEL,
        'Failed to restore configuration',
        error,
      );
    }
  }

  /**
   * Clear all history items
   */
  private async clearHistory() {
    try {
      await AgentHistoryManager.clearHistory();
      vscode.window.showInformationMessage('Agent history cleared');

      // Notify the webview
      if (this._view) {
        this._view.webview.postMessage({
          command: HISTORY_VIEW_COMMANDS.HISTORY_CLEARED,
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to clear history: ${error}`);
    }
  }

  /**
   * Delete a single history item by ID
   */
  private async deleteHistoryItem(historyId: string) {
    try {
      logger.debug(CHANNEL, `Deleting history item: ${historyId}`);

      // Use the AgentHistoryManager to delete the item
      const deleted =
        await AgentHistoryManager.deleteHistoryItemById(historyId);

      if (deleted) {
        // Update the view
        await this.sendHistoryData();
      } else {
        vscode.window.showWarningMessage(
          `History item not found: ${historyId}`,
        );
      }
    } catch (error) {
      await showLoggedErrorMessage(
        CHANNEL,
        'Failed to delete history item',
        error,
      );
    }
  }
}
