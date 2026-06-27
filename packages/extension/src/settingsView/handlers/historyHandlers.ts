/**
 * History and chat-export domain handlers.
 *
 * Handles rerun/restore/delete of past executions, clearing history,
 * and exporting a conversation as Markdown, LaTeX/PDF, or self-contained HTML.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import {
  ChatExportController,
  type ChatExportInput,
  type ExportInputStatus,
} from '@controllers/settingsView/ChatExportController';
import {
  deleteAllRuntimeHistoryExecutions,
  deleteRuntimeHistoryExecution,
  readRuntimeHistoryConfig,
  type RuntimeHistoryAgentConfig,
} from '@agent/runtime/historyCommands';
import { getRuntimeActiveExecutionIds } from '@agent/runtime/executionQueries';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ExecutionId } from '@shared/schemas';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas/settingsViewMessages';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

type ChatExportFormat = 'md' | 'tex' | 'html';

/** History and chat-export handler delegate. */
export class HistoryHandlers {
  private readonly chatExportController = new ChatExportController();

  /** Path to the bundled HTML export assets (under extension resources). */
  private readonly htmlAssetsSrc: string;

  constructor(private readonly ctx: SettingsHandlerContext) {
    this.htmlAssetsSrc = path.join(
      ctx.extensionContext.extensionPath,
      'resources',
      'htmlExport',
    );
  }

  async sendHistoryData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(await buildHistoryMessage());
  }

  async handleRerunAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.RERUN_AGENT>,
  ): Promise<void> {
    await this.withHistoryConfig(
      data.historyId,
      'Failed to rerun agent',
      async (config) => {
        await vscode.window.showInformationMessage(
          'Rerunning agent from history',
        );
        await runExecuteCommand(config);
      },
    );
  }

  async handleRestoreAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.RESTORE_AGENT>,
  ): Promise<void> {
    await this.withHistoryConfig(
      data.historyId,
      'Failed to restore configuration',
      async (config) => {
        const taskState = agentConfigToTaskState(config);
        await vscode.commands.executeCommand('texra.restoreState', taskState);
      },
    );
  }

  async handleDeleteAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT>,
  ): Promise<void> {
    try {
      const activeIds = getRuntimeActiveExecutionIds();
      if (activeIds.includes(data.historyId)) {
        await vscode.window.showWarningMessage(
          'Cannot delete a running execution',
        );
        return;
      }
      const deleted = await deleteRuntimeHistoryExecution(
        data.historyId as ExecutionId,
      );
      if (deleted) {
        await this.ctx.withActiveWebview((w) => this.sendHistoryData(w));
      } else {
        await vscode.window.showWarningMessage(
          `History item not found: ${data.historyId}`,
        );
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to delete history item',
        error,
      );
    }
  }

  async handleClearHistory(): Promise<void> {
    try {
      await deleteAllRuntimeHistoryExecutions(
        new Set(getRuntimeActiveExecutionIds()),
      );
      await vscode.window.showInformationMessage('Agent history cleared');
      await this.ctx.withActiveWebview(async (w) => {
        await w.postMessage({
          command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
        });
      });
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to clear history',
        error,
      );
    }
  }

  async handleExportChat(
    data: { historyId: string },
    format: ChatExportFormat,
  ): Promise<void> {
    try {
      const result = await this.chatExportController.buildExportInput(
        data.historyId,
      );

      if (result.status !== 'ok') {
        this.reportExportInputError(result.status);
        return;
      }

      const { exportInput } = result;

      if (format === 'html') {
        await this.exportAndOpenHtml(data.historyId, exportInput);
        return;
      }

      if (format === 'md') {
        await this.exportAndOpenMarkdown(data.historyId, exportInput);
      } else {
        await this.exportAndOpenLatex(data.historyId, exportInput);
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to export chat',
        error,
      );
    }
  }

  // ==========================================================
  // Private helpers
  // ==========================================================

  /**
   * Translate the controller's export-input status into a user-visible
   * error message.
   */
  private reportExportInputError(
    status: Exclude<ExportInputStatus, 'ok'>,
  ): void {
    switch (status) {
      case 'config_missing':
        void vscode.window.showErrorMessage('History item not found');
        return;
      case 'conversation_missing':
        void vscode.window.showErrorMessage(
          'No conversation data available for this execution',
        );
        return;
    }
  }

  private async exportAndOpenMarkdown(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<void> {
    const { absolutePath, storagePath } =
      await this.chatExportController.exportAsMarkdown(historyId, exportInput);
    const doc = await vscode.workspace.openTextDocument(absolutePath);
    await vscode.window.showTextDocument(doc, { preview: false });
    const filename = storagePath.split('/').pop() ?? storagePath;
    void vscode.window.showInformationMessage(`Chat exported: ${filename}`);
  }

  private async exportAndOpenLatex(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<void> {
    const { absolutePath, storagePath, pdfPath } =
      await this.chatExportController.exportAsLatex(historyId, exportInput);

    if (pdfPath) {
      // Open the generated PDF
      const pdfUri = vscode.Uri.file(pdfPath);
      await vscode.commands.executeCommand('vscode.open', pdfUri);
      const filename = storagePath.split('/').pop() ?? storagePath;
      void vscode.window.showInformationMessage(
        `Chat exported and compiled: ${filename.replace('.tex', '.pdf')}`,
      );
    } else {
      // Compilation failed — open the .tex source instead
      const doc = await vscode.workspace.openTextDocument(absolutePath);
      await vscode.window.showTextDocument(doc, { preview: false });
      void vscode.window.showWarningMessage(
        'LaTeX compilation failed. The .tex source file has been opened instead.',
      );
    }
  }

  private async exportAndOpenHtml(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<void> {
    const { absolutePath, folderName } =
      await this.chatExportController.exportAsHtml(
        historyId,
        exportInput,
        this.htmlAssetsSrc,
      );

    await vscode.env.openExternal(vscode.Uri.file(absolutePath));
    void vscode.window.showInformationMessage(
      `Chat exported to ${folderName}/index.html`,
    );
  }

  private async withHistoryConfig(
    historyId: string,
    errorPrefix: string,
    action: (config: RuntimeHistoryAgentConfig) => Promise<void>,
  ): Promise<void> {
    try {
      const config = await readRuntimeHistoryConfig(historyId as ExecutionId);
      if (!config) {
        await vscode.window.showErrorMessage('History item not found');
        return;
      }
      await action(config);
    } catch (error) {
      await showLoggedErrorMessage(this.ctx.channel, errorPrefix, error);
    }
  }
}
