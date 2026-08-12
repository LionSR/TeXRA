/**
 * History and chat-export domain handlers.
 *
 * Handles rerun/restore/delete of past executions, clearing history,
 * and exporting a conversation as Markdown, LaTeX/PDF, or self-contained HTML.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  getExecutionStore,
  deleteExecution,
  deleteAllExecutions,
} from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import {
  ChatExportController,
  type ChatExportInput,
} from '@controllers/settingsView/ChatExportController';
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import {
  ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
  CLEAR_HISTORY_CONFIRM_LABEL,
  CLEAR_HISTORY_CONFIRM_MESSAGE,
  describeClearHistoryResult,
  describeDeleteExecutionResult,
  describeLatexExportResult,
  exportedFileMessage,
  exportInputErrorMessage,
  HISTORY_CLEARED_MESSAGE,
  HISTORY_CONFIG_UNREADABLE_MESSAGE,
  htmlExportErrorMessage,
} from '@controllers/settingsView/HistoryActionOutcomes';
import { confirmModal } from '@frontend/ui/dialogs';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
// Bundled in the extension's resources/ tree and loaded as raw text by the
// esbuild `.tex: text` loader, then injected into the host-neutral
// ChatExportController so core stays free of `@resources`.
import latexPreamble from '@resources/templates/chatExport.tex';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas/settingsViewMessages';
import { GoalStore } from '@tools/goal';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

type ChatExportFormat = 'md' | 'tex' | 'html';

/** History and chat-export handler delegate. */
export class HistoryHandlers {
  private readonly chatExportController = new ChatExportController({
    latexPreamble,
  });

  /** Path to the bundled trace-viewer template (under extension resources). */
  private readonly traceViewerTemplate: string;

  constructor(private readonly ctx: SettingsHandlerContext) {
    this.traceViewerTemplate = path.join(
      ctx.extensionContext.extensionPath,
      'resources',
      'traceViewer',
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
        await vscode.commands.executeCommand('texra.restoreState', config);
      },
    );
  }

  async handleDeleteAgent(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to delete history item',
      async () => {
        const executionId = data.historyId;
        const result = await deleteExecution(executionId);
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
            await GoalStore.forgetByExecutionIds([executionId]);
            await this.ctx.withActiveWebview((w) => this.sendHistoryData(w));
            return;
        }
      },
    );
  }

  async handleClearHistory(): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to clear history',
      async () => {
        const confirmed = await confirmModal(
          CLEAR_HISTORY_CONFIRM_MESSAGE,
          CLEAR_HISTORY_CONFIRM_LABEL,
        );
        if (!confirmed) return;
        const result = await deleteAllExecutions();
        await GoalStore.forgetByExecutionIds(result.deleted);
        const outcome = describeClearHistoryResult(result);
        if (outcome.kind === 'cleared') {
          await vscode.window.showInformationMessage(HISTORY_CLEARED_MESSAGE);
          await this.ctx.withActiveWebview(async (w) => {
            await w.postMessage({
              command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
            });
          });
        } else {
          await vscode.window.showInformationMessage(outcome.message);
          await this.ctx.withActiveWebview((w) => this.sendHistoryData(w));
        }
      },
    );
  }

  async handleExportChat(
    data: { historyId: string },
    format: ChatExportFormat,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to export chat',
      async () => {
        // HTML reads the execution's trace directly via assembleTrace, whose
        // missing-data statuses are shaped differently from
        // buildExportInput's, so it takes its own path.
        if (format === 'html') {
          await this.exportAndOpenHtml(data.historyId);
          return;
        }

        const result = await this.chatExportController.buildExportInput(
          data.historyId,
        );

        if (result.status !== 'ok') {
          void showLoggedMessage(
            this.ctx.channel,
            exportInputErrorMessage(result.status),
          );
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
      },
    );
  }

  // ==========================================================
  // Private helpers
  // ==========================================================

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
      this.traceViewerTemplate,
    );

    // assembleTrace's failure statuses, surfaced through exportAsHtml.
    if (outcome.status !== 'ok') {
      void showLoggedMessage(
        this.ctx.channel,
        htmlExportErrorMessage(outcome.status),
      );
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
    await withHandlerErrorHandling(this.ctx, errorPrefix, async () => {
      // readConfig() validates against AgentConfigSchema and returns null for
      // both missing and corrupt configs; distinguishing them belongs to the
      // storage layer, not here.
      const config = await getExecutionStore(historyId).readConfig();
      if (!config) {
        await showLoggedMessage(
          this.ctx.channel,
          HISTORY_CONFIG_UNREADABLE_MESSAGE,
        );
        return;
      }
      await action(config);
    });
  }
}
