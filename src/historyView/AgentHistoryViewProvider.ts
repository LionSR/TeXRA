import * as vscode from 'vscode';

// Local imports - core
import { AgentHistoryManager } from './AgentHistoryManager';
import { executeCommand } from '../commands/executeCommand';

import { agentConfigToTaskState } from '../utils/configConversion';
import { buildWebviewHtml } from '../utils/webviewHtmlUtils';

// Local imports - log
import * as logger from '../logger/logUtils';

const CHANNEL = 'AgentHistoryViewProvider';
logger.initialize(CHANNEL);

export class AgentHistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'texra.historyView';
  private _view?: vscode.WebviewPanel;

  constructor(private readonly context: vscode.ExtensionContext) {}

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
      AgentHistoryViewProvider.viewType,
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
    getHistoryData: () => this.sendHistoryData(),
    rerunAgent: (m) => this.rerunAgent(m.historyId),
    restoreAgent: (m) => this.restoreAgent(m.historyId),
    deleteAgent: (m) => this.deleteHistoryItem(m.historyId),
    clearHistory: () => this.clearHistory(),
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
    const history = await AgentHistoryManager.getHistory(this.context);

    // Send data to the webview
    if (this._view) {
      this._view.webview.postMessage({
        command: 'updateHistory',
        historyItems: history,
      });
    }
  }

  /**
   * Update the content of the webview
   */
  private async updateWebviewContent() {
    if (this._view) {
      this._view.webview.html = this.getWebviewContent();

      // Send history data after a short delay to ensure the webview is ready
      setTimeout(() => this.sendHistoryData(), 100);
    }
  }

  /**
   * Generate the HTML content for the webview by loading the HTML file
   */
  private getWebviewContent(): string {
    try {
      const getHistoryViewPath = (path: string) =>
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'historyView',
          path,
        );
      const getHistoryViewUri = (path: string) =>
        this._view!.webview.asWebviewUri(getHistoryViewPath(path));
      const getCommonUri = (path: string) =>
        this._view!.webview.asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, 'src', 'common', path),
        );
      const getNodeModulesUri = (path: string) =>
        this._view!.webview.asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', path),
        );

      const htmlPath = getHistoryViewPath('index.html');
      const scriptUri = getHistoryViewUri('script.js');
      const styleUri = getHistoryViewUri('style.css');
      const domHandlersUri = getHistoryViewUri('modules/domHandlers.js');

      // Common module URIs
      const vscodeApiUri = getCommonUri('modules/vscodeApi.js');
      const messageRouterUri = getCommonUri('modules/messageRouter.js');
      const commonStyleUri = getCommonUri('styles/common.css');

      // Node modules URIs
      const codiconUri = getNodeModulesUri('@vscode/codicons/dist/codicon.css');

      return buildWebviewHtml(this._view!.webview, htmlPath, {
        scriptUri,
        styleUri,
        commonStyleUri,
        vscodeApiUri,
        messageRouterUri,
        domHandlersUri,
        codiconUri,
      });
    } catch (error) {
      console.error('Error generating HTML content:', error);
      return `<html><body><h1>Error loading history view</h1><p>${error}</p></body></html>`;
    }
  }

  /**
   * Rerun an agent with the configuration from history
   */
  private async rerunAgent(historyId: string) {
    try {
      const historyItem = await AgentHistoryManager.getHistoryItemById(
        this.context,
        historyId,
      );

      if (historyItem) {
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
      const historyItem = await AgentHistoryManager.getHistoryItemById(
        this.context,
        historyId,
      );

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
      logger.error(CHANNEL, `Failed to restore configuration: ${error}`);
      vscode.window.showErrorMessage(
        `Failed to restore configuration: ${error}`,
      );
    }
  }

  /**
   * Clear all history items
   */
  private async clearHistory() {
    try {
      await AgentHistoryManager.clearHistory(this.context);
      vscode.window.showInformationMessage('Agent history cleared');

      // Notify the webview
      if (this._view) {
        this._view.webview.postMessage({ command: 'historyCleared' });
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
      const deleted = await AgentHistoryManager.deleteHistoryItemById(
        this.context,
        historyId,
      );

      if (deleted) {
        // Update the view
        await this.sendHistoryData();
      } else {
        vscode.window.showWarningMessage(
          `History item not found: ${historyId}`,
        );
      }
    } catch (error) {
      logger.error(CHANNEL, `Failed to delete history item: ${error}`);
      vscode.window.showErrorMessage(`Failed to delete history item: ${error}`);
    }
  }
}
