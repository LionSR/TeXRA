/**
 * History and chat-export domain handlers.
 *
 * Handles rerun/restore/delete of past executions, clearing history,
 * and exporting a conversation as Markdown, LaTeX/PDF, or self-contained HTML.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

// The `.tex` template is bundled in the extension's resources/ tree and loaded
// as raw text by the esbuild `.tex: text` loader; it is injected into the
// host-neutral ChatExportController so core stays free of `@resources`.

import {
  getExecutionStore,
  deleteExecution,
  deleteAllExecutions,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import {
  ChatExportController,
  type ChatExportInput,
  type ExportInputStatus,
} from '@controllers/settingsView/ChatExportController';
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import {
  ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
  describeClearHistoryResult,
  describeDeleteExecutionResult,
  describeLatexExportResult,
  exportedFileMessage,
  exportInputErrorMessage,
  HISTORY_ITEM_NOT_FOUND_MESSAGE,
  htmlExportErrorMessage,
} from '@controllers/settingsView/HistoryActionOutcomes';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import latexPreamble from '@resources/templates/chatExport.tex';
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
  private readonly chatExportController = new ChatExportController({
    latexPreamble,
  });

  /** Path to the bundled trace-viewer standalone template (under extension resources). */
  private readonly traceViewerStandaloneTemplate: string;

  constructor(private readonly ctx: SettingsHandlerContext) {
    this.traceViewerStandaloneTemplate = path.join(
      ctx.extensionContext.extensionPath,
      'resources',
      'traceViewerStandalone',
      'index.html',
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
      const result = await deleteExecution(data.historyId as ExecutionId);
      const outcome = describeDeleteExecutionResult(result);
      switch (outcome.kind) {
        case 'active':
          await vscode.window.showWarningMessage(
            ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
          );
          return;
        case 'not-found':
          await vscode.window.showWarningMessage(outcome.message);
          return;
        case 'deleted':
          await this.ctx.withActiveWebview((w) => this.sendHistoryData(w));
          return;
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
      const result = await deleteAllExecutions();
      const outcome = describeClearHistoryResult(result);
      if (outcome.kind === 'cleared') {
        await vscode.window.showInformationMessage('Agent history cleared');
        await this.ctx.withActiveWebview(async (w) => {
          await w.postMessage({
            command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
          });
        });
      } else {
        await vscode.window.showInformationMessage(outcome.message);
        await this.ctx.withActiveWebview((w) => this.sendHistoryData(w));
      }
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
      // HTML no longer goes through buildExportInput/ChatExportInput — it
      // reads the execution's trace directly via assembleTrace, which has
      // its own independent (and differently-shaped) missing-data statuses.
      if (format === 'html') {
        await this.exportAndOpenHtml(data.historyId);
        return;
      }

      const result = await this.chatExportController.buildExportInput(
        data.historyId,
      );

      if (result.status !== 'ok') {
        this.reportExportInputError(result.status);
        return;
      }

      const { exportInput } = result;

      switch (format) {
        case 'md':
          await this.exportAndOpenMarkdown(data.historyId, exportInput);
          return;
        case 'tex':
          await this.exportAndOpenLatex(data.historyId, exportInput);
          return;
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
    void showLoggedMessage(this.ctx.channel, exportInputErrorMessage(status));
  }

  /**
   * Translate assembleTrace's failure statuses (surfaced through
   * ChatExportController.exportAsHtml) into a user-visible error message.
   */
  private reportHtmlExportError(
    status: 'config_missing' | 'streamLogs_missing',
  ): void {
    void showLoggedMessage(this.ctx.channel, htmlExportErrorMessage(status));
  }

  private async exportAndOpenMarkdown(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<void> {
    const { absolutePath, storagePath } =
      await this.chatExportController.exportAsMarkdown(historyId, exportInput);
    const doc = await vscode.workspace.openTextDocument(absolutePath);
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage(exportedFileMessage(storagePath));
  }

  private async exportAndOpenLatex(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<void> {
    const result = await this.chatExportController.exportAsLatex(
      historyId,
      exportInput,
    );
    const outcome = describeLatexExportResult(result);

    if (outcome.kind === 'compiled') {
      const pdfUri = vscode.Uri.file(outcome.pathToOpen);
      await vscode.commands.executeCommand('vscode.open', pdfUri);
      void vscode.window.showInformationMessage(outcome.message);
      return;
    }

    // Compilation failed — open the .tex source instead, and log the
    // compile log tail so the failure reason is discoverable. Included in
    // the visible message itself, not just `data` — the logger only shows
    // `data` when texra.logger.debugMode is on (default off).
    if (outcome.logDetail) {
      this.ctx.logger.error(this.ctx.channel, outcome.logDetail, {
        data: { storagePath: result.storagePath, logTail: result.logTail },
      });
    }
    const doc = await vscode.workspace.openTextDocument(outcome.pathToOpen);
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showWarningMessage(outcome.message);
  }

  private async exportAndOpenHtml(historyId: string): Promise<void> {
    const outcome = await this.chatExportController.exportAsHtml(
      historyId,
      this.traceViewerStandaloneTemplate,
    );

    if (outcome.status !== 'ok') {
      this.reportHtmlExportError(outcome.status);
      return;
    }

    const { absolutePath, storagePath } = outcome.result;
    await vscode.env.openExternal(vscode.Uri.file(absolutePath));
    void vscode.window.showInformationMessage(exportedFileMessage(storagePath));
  }

  private async withHistoryConfig(
    historyId: string,
    errorPrefix: string,
    action: (config: AgentConfig) => Promise<void>,
  ): Promise<void> {
    try {
      const raw = await getExecutionStore(
        historyId as ExecutionId,
      ).readConfig();
      if (!raw) {
        await showLoggedMessage(
          this.ctx.channel,
          HISTORY_ITEM_NOT_FOUND_MESSAGE,
        );
        return;
      }
      const config = AgentConfigSchema.parse(raw);
      await action(config);
    } catch (error) {
      await showLoggedErrorMessage(this.ctx.channel, errorPrefix, error);
    }
  }
}
