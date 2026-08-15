/** Extension ports and dispatcher bindings for shared history actions. */
import * as path from 'node:path';
import * as vscode from 'vscode';

import { runExecuteCommand } from '@commands/agent/executeCommand';
import { ChatExportController } from '@controllers/settingsView/ChatExportController';
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import {
  HistoryActions,
  type HistoryActionPorts,
  type HistoryOpenKind,
} from '@controllers/settingsView/backend/HistoryActions';
import { confirmModal } from '@frontend/ui/dialogs';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import latexPreamble from '@resources/templates/chatExport.tex';
import { SETTINGS_VIEW_CMD, type SettingsMessageFor } from '@shared/schemas';

import {
  type SettingsHandlerContext,
  withHandlerErrorHandling,
} from './SettingsHandlerContext';

export class HistoryHandlers {
  private readonly actions: HistoryActions;

  constructor(private readonly ctx: SettingsHandlerContext) {
    const controller = new ChatExportController({ latexPreamble });
    const ports: HistoryActionPorts = {
      getChatExportController: () => Promise.resolve(controller),
      traceViewerTemplate: path.join(
        ctx.extensionContext.extensionPath,
        'resources',
        'traceViewer',
        'index.html',
      ),
      runExecution: ({ config }) => runExecuteCommand(config),
      restoreRunConfig: async (config) => {
        await vscode.commands.executeCommand('texra.restoreState', config);
      },
      postMessage: async (message) => {
        await ctx.withActiveWebview(async (webview) => {
          await webview.postMessage(message);
        });
      },
      openPath: (filePath, kind) => this.openPath(filePath, kind),
      showInfo: async (message) => {
        await vscode.window.showInformationMessage(message);
      },
      showWarning: async (message) => {
        await vscode.window.showWarningMessage(message);
      },
      showError: async (message) => {
        await showLoggedMessage(ctx.channel, message);
      },
      confirm: confirmModal,
      reportDetail: (message, data) =>
        ctx.logger.error(ctx.channel, message, { data }),
    };
    this.actions = new HistoryActions(ports);
  }

  async sendHistoryData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(await buildHistoryMessage());
  }

  handleRerunAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.RERUN_AGENT>,
  ): Promise<void> {
    return this.run('Failed to rerun agent', () =>
      this.actions.rerun(data.historyId),
    );
  }

  handleRestoreAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.RESTORE_AGENT>,
  ): Promise<void> {
    return this.run('Failed to restore configuration', () =>
      this.actions.restore(data.historyId),
    );
  }

  handleDeleteAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT>,
  ): Promise<void> {
    return this.run('Failed to delete history item', () =>
      this.actions.deleteItem(data.historyId),
    );
  }

  handleClearHistory(): Promise<void> {
    return this.run('Failed to clear history', () => this.actions.clear());
  }

  handleExportChat(
    data: { historyId: string },
    format: 'md' | 'tex' | 'html',
  ): Promise<void> {
    return this.run('Failed to export chat', () =>
      this.actions.exportChat(data.historyId, format),
    );
  }

  private run(errorPrefix: string, action: () => Promise<void>): Promise<void> {
    return withHandlerErrorHandling(this.ctx, errorPrefix, action);
  }

  private async openPath(
    filePath: string,
    kind: HistoryOpenKind,
  ): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    if (kind === 'external') {
      await vscode.env.openExternal(uri);
      return;
    }
    if (kind === 'pdf') {
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document, { preview: false });
  }
}
