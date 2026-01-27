/**
 * Schema-driven message handler for HistoryView.
 *
 * Uses discriminated union validation at dispatch point (single safeParse)
 * with typed handler registry for type-safe message handling.
 */
import * as vscode from 'vscode';

import {
  dispatchHistoryViewInbound,
  type HistoryViewInboundHandlerRegistry,
  type HistoryViewInboundMessage,
} from '@shared/schemas/historyViewMessages';
import { showLoggedErrorMessage } from '@common/errors';
import { HISTORY_VIEW_COMMANDS } from '@common/webview';
import { AgentHistoryManager, type AgentHistoryItem } from '@common/history';
import * as logger from '@logger/logUtils';
import { agentConfigToTaskState } from '@utils/config/configConversion';
import { runExecuteCommand } from '@commands/agent/executeCommand';

// Type helper for extracting specific message types
type MessageFor<C extends HistoryViewInboundMessage['command']> = Extract<
  HistoryViewInboundMessage,
  { command: C }
>;

export class HistoryViewMessageHandler {
  private readonly channel = 'HistoryViewMessageHandler';
  private _activeView: vscode.WebviewView | vscode.WebviewPanel | undefined;
  private readonly handlers: HistoryViewInboundHandlerRegistry;

  constructor(_context: vscode.ExtensionContext) {
    logger.initialize(this.channel);
    this.handlers = this.createHandlers();
  }

  private getActiveView():
    | vscode.WebviewView
    | vscode.WebviewPanel
    | undefined {
    return this._activeView;
  }

  private createHandlers(): HistoryViewInboundHandlerRegistry {
    return {
      [HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA]: () =>
        this.handleGetHistoryData(),
      [HISTORY_VIEW_COMMANDS.RERUN_AGENT]: (data) =>
        this.handleRerunAgent(data),
      [HISTORY_VIEW_COMMANDS.RESTORE_AGENT]: (data) =>
        this.handleRestoreAgent(data),
      [HISTORY_VIEW_COMMANDS.DELETE_AGENT]: (data) =>
        this.handleDeleteAgent(data),
      [HISTORY_VIEW_COMMANDS.CLEAR_HISTORY]: () => this.handleClearHistory(),
    };
  }

  public async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    this._activeView = webviewView;

    const handled = dispatchHistoryViewInbound(
      message,
      this.handlers,
      (error) => {
        logger.debug(this.channel, 'Message validation failed', {
          data: error,
        });
      },
    );

    if (
      !handled &&
      message &&
      typeof message === 'object' &&
      'command' in message
    ) {
      logger.warn(
        this.channel,
        `Unhandled command: ${(message as { command: string }).command}`,
      );
    }
  }

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendHistoryData(webview: vscode.Webview): Promise<void> {
    const history = await AgentHistoryManager.getHistory();
    await webview.postMessage({
      command: HISTORY_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: history,
    });
  }

  // ============================================================
  // Handler implementations
  // ============================================================

  private async handleGetHistoryData(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendHistoryData(view.webview);
    }
  }

  private async handleRerunAgent(
    data: MessageFor<typeof HISTORY_VIEW_COMMANDS.RERUN_AGENT>,
  ): Promise<void> {
    await this.withHistoryItem(
      data.historyId,
      'rerunAgent',
      async (historyItem) => {
        await vscode.window.showInformationMessage(
          'Rerunning agent from history',
        );
        await runExecuteCommand(historyItem.agentConfig);
      },
      'Failed to rerun agent',
    );
  }

  private async handleRestoreAgent(
    data: MessageFor<typeof HISTORY_VIEW_COMMANDS.RESTORE_AGENT>,
  ): Promise<void> {
    await this.withHistoryItem(
      data.historyId,
      'restoreAgent',
      async (historyItem) => {
        const taskState = agentConfigToTaskState(historyItem.agentConfig);
        await vscode.commands.executeCommand('texra.restoreState', taskState);
      },
      'Failed to restore configuration',
    );
  }

  private async handleDeleteAgent(
    data: MessageFor<typeof HISTORY_VIEW_COMMANDS.DELETE_AGENT>,
  ): Promise<void> {
    const view = this.getActiveView();
    try {
      const deleted = await AgentHistoryManager.deleteHistoryItemById(
        data.historyId,
      );
      if (deleted && view) {
        await this.sendHistoryData(view.webview);
      } else if (!deleted) {
        await vscode.window.showWarningMessage(
          `History item not found: ${data.historyId}`,
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

  private async handleClearHistory(): Promise<void> {
    const view = this.getActiveView();
    try {
      await AgentHistoryManager.clearHistory();
      await vscode.window.showInformationMessage('Agent history cleared');
      await view?.webview.postMessage({
        command: HISTORY_VIEW_COMMANDS.HISTORY_CLEARED,
      });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to clear history',
        error,
      );
    }
  }

  // ============================================================
  // Helper methods
  // ============================================================

  private async withHistoryItem(
    historyId: string,
    operationName: string,
    action: (historyItem: AgentHistoryItem) => Promise<void>,
    errorPrefix: string,
  ): Promise<void> {
    try {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(historyId);
      if (!historyItem) {
        await vscode.window.showErrorMessage('History item not found');
        return;
      }
      await action(historyItem);
    } catch (error) {
      logger.error(this.channel, `${operationName} failed`, { data: error });
      await showLoggedErrorMessage(this.channel, errorPrefix, error);
    }
  }
}
