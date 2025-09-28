// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view
import { executeCommand } from '@commands/agent/executeCommand';
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

// Local imports - common
import {
  BaseViewMessageHandler,
  type MessageHandler,
} from '@common/webview/BaseViewMessageHandler';

// @ts-ignore - Import JavaScript module
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands';
import { resolveAgentSessionMetadata } from '@agent/core/AgentDataclass';
import { AgentHistoryManager } from '@historyView/managers';
import { agentConfigToTaskState } from '@utils/config';

export class HistoryViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  constructor(private readonly context: vscode.ExtensionContext) {
    super('HistoryView');
  }

  protected createHandlers(): Record<
    string,
    MessageHandler<vscode.WebviewView | vscode.WebviewPanel>
  > {
    return {
      [HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA]:
        this.handleGetHistoryData.bind(this),
      [HISTORY_VIEW_COMMANDS.RERUN_AGENT]: this.handleRerunAgent.bind(this),
      [HISTORY_VIEW_COMMANDS.RESTORE_AGENT]: this.handleRestoreAgent.bind(this),
      [HISTORY_VIEW_COMMANDS.DELETE_AGENT]: this.handleDeleteAgent.bind(this),
      [HISTORY_VIEW_COMMANDS.CLEAR_HISTORY]: this.handleClearHistory.bind(this),
    };
  }

  public async sendHistoryData(webview: vscode.Webview): Promise<void> {
    const history = await AgentHistoryManager.getHistory();
    await webview.postMessage({
      command: HISTORY_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: history,
    });
  }

  private async handleGetHistoryData(
    _message: any,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.sendHistoryData(view.webview);
  }

  private async handleRerunAgent(
    message: any,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    const historyId: string | undefined = message.historyId;
    if (!historyId) return;

    try {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(historyId);
      if (historyItem) {
        await vscode.window.showInformationMessage(
          'Rerunning agent from history',
        );
        await executeCommand.executeCommand(historyItem.config, this.context);
      } else {
        await vscode.window.showErrorMessage('History item not found');
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to rerun agent: ${error}`);
    }
  }

  private async handleRestoreAgent(
    message: any,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    const historyId: string | undefined = message.historyId;
    if (!historyId) return;
    try {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(historyId);
      if (historyItem) {
        const metadata = resolveAgentSessionMetadata(
          historyItem.agentType,
          historyItem.agentSessionKind,
        );
        const taskState = agentConfigToTaskState(
          historyItem.config,
          metadata,
        );
        await vscode.commands.executeCommand('texra.restoreState', taskState);
      } else {
        await vscode.window.showErrorMessage('History item not found');
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to restore configuration',
        error,
      );
    }
  }

  private async handleDeleteAgent(
    message: any,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    const historyId: string | undefined = message.historyId;
    if (!historyId) return;
    try {
      const deleted =
        await AgentHistoryManager.deleteHistoryItemById(historyId);
      if (deleted) {
        await this.sendHistoryData(view.webview);
      } else {
        await vscode.window.showWarningMessage(
          `History item not found: ${historyId}`,
        );
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete history item',
        error,
      );
    }
  }

  private async handleClearHistory(
    _message: any,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    try {
      await AgentHistoryManager.clearHistory();
      await vscode.window.showInformationMessage('Agent history cleared');
      await view.webview.postMessage({
        command: HISTORY_VIEW_COMMANDS.HISTORY_CLEARED,
      });
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to clear history: ${error}`);
    }
  }
}
