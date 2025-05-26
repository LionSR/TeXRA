import * as fs from 'fs';
import * as vscode from 'vscode';

// Local imports - core
import { AgentHistoryManager } from './AgentHistoryManager';
import { executeCommand } from '../commands/executeCommand';

import { agentConfigToTaskState } from '../utils/configConversion';
import { generateNonce } from '../utils/nonceUtils';

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
  private async handleWebviewMessage(message: any) {
    switch (message.command) {
      case 'getHistoryData':
        await this.sendHistoryData();
        break;

      case 'rerunAgent':
        await this.rerunAgent(message.historyId);
        break;

      case 'restoreAgent':
        await this.restoreAgent(message.historyId);
        break;

      case 'deleteAgent':
        await this.deleteHistoryItem(message.historyId);
        break;

      case 'clearHistory':
        await this.clearHistory();
        break;
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
      // Get the path to HTML file
      const htmlPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'historyView',
        'index.html',
      );
      const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');

      // Get the paths for scripts and styles
      const scriptUri = this.getWebviewUri('script.js');
      const styleUri = this.getWebviewUri('style.css');
      const vscodeApiUri = this.getWebviewUri('modules/vscodeApi.js');
      const domHandlersUri = this.getWebviewUri('modules/domHandlers.js');
      const codiconPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'node_modules',
        '@vscode',
        'codicons',
        'dist',
        'codicon.css',
      );
      const codiconUri = this._view?.webview.asWebviewUri(codiconPath);
      const commonStyleUri = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'common',
        'styles',
        'common.css',
      );

      // Create a nonce for script security
      const nonce = generateNonce();

      // Replace placeholders in HTML with actual content
      return htmlContent
        .replace('${scriptUri}', scriptUri.toString())
        .replace('${styleUri}', styleUri.toString())
        .replace(
          '${commonStyleUri}',
          this._view
            ? this._view.webview.asWebviewUri(commonStyleUri).toString()
            : '',
        )
        .replace('${vscodeApiUri}', vscodeApiUri.toString())
        .replace('${domHandlersUri}', domHandlersUri.toString())
        .replace('${codiconUri}', codiconUri?.toString() ?? '')
        .replace(/\${nonce}/g, nonce)
        .replace(/\${cspSource}/g, this._view?.webview.cspSource ?? '');
    } catch (error) {
      console.error('Error generating HTML content:', error);
      return `<html><body><h1>Error loading history view</h1><p>${error}</p></body></html>`;
    }
  }

  /**
   * Get a webview URI for a local resource
   */
  private getWebviewUri(relativePath: string): vscode.Uri {
    if (!this._view) {
      throw new Error('Webview is not available');
    }

    const diskPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'src',
      'historyView',
      relativePath,
    );
    return this._view.webview.asWebviewUri(diskPath);
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
