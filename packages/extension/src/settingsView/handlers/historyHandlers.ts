/**
 * History and chat-export domain handlers.
 *
 * Handles rerun/restore/delete of past executions, clearing history,
 * and exporting a conversation as Markdown, LaTeX/PDF, or self-contained HTML.
 */
import * as vscode from 'vscode';

import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import {
  getExecutionStore,
  deleteExecution,
  deleteAllExecutions,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { executionRegistry } from '@agent/runtime/executionRegistry';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import {
  formatChatAsMarkdown,
  formatChatAsLatex,
  generateExportFilename,
  generateExportFolderName,
  type ChatExportInput,
} from '@commands/history/chatExportFormatter';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { compileLatex2Pdf } from '@latex/texTools';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ExecutionId } from '@shared/schemas';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas/settingsViewMessages';
import { StorageFS } from '@utils/files';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

type ChatExportFormat = 'md' | 'tex' | 'html';

/** History and chat-export handler delegate. */
export class HistoryHandlers {
  /** Used by HTML export to locate the bundled assets. */
  private readonly extensionPath: string;

  constructor(private readonly ctx: SettingsHandlerContext) {
    this.extensionPath = ctx.extensionContext.extensionPath;
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
      const activeIds = executionRegistry.getActiveIds();
      if (activeIds.includes(data.historyId)) {
        await vscode.window.showWarningMessage(
          'Cannot delete a running execution',
        );
        return;
      }
      const deleted = await deleteExecution(data.historyId as ExecutionId);
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
      await deleteAllExecutions(new Set(executionRegistry.getActiveIds()));
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
      const store = getExecutionStore(data.historyId as ExecutionId);
      const [rawConfig, conversation, meta] = await Promise.all([
        store.readConfig(),
        store.readConversation(),
        store.readMeta(),
      ]);

      if (!rawConfig) {
        await vscode.window.showErrorMessage('History item not found');
        return;
      }

      if (!conversation) {
        await vscode.window.showErrorMessage(
          'No conversation data available for this execution',
        );
        return;
      }

      const config = AgentConfigSchema.parse(rawConfig);

      const exportInput: ChatExportInput = {
        timestamp: meta?.timestamp ?? new Date().toISOString(),
        description: meta?.description,
        config: {
          agent: config.agent,
          model: config.model,
          instruction: config.instruction,
          inputFiles: config.inputFiles,
          mediaFiles: config.mediaFiles,
          contextFiles: config.contextFiles,
          outputFiles: config.outputFiles,
        },
        messages: conversation,
      };

      if (format === 'html') {
        await this.exportChatAsHtml(data.historyId, exportInput);
        return;
      }

      const filename = generateExportFilename(exportInput, format);
      const storagePath = `executions/${data.historyId}/${filename}`;

      const content =
        format === 'md'
          ? formatChatAsMarkdown(exportInput)
          : formatChatAsLatex(exportInput);

      await StorageFS.write(storagePath, content);
      const absolutePath = StorageFS.fullPath(storagePath);

      if (format === 'tex') {
        // Compile LaTeX to PDF
        const { pathToLocation } = await import('@utils/files');
        const location = pathToLocation(absolutePath);
        const compiled = await compileLatex2Pdf(location);

        if (compiled) {
          // Open the generated PDF
          const pdfPath = absolutePath.replace(/\.tex$/, '.pdf');
          const pdfUri = vscode.Uri.file(pdfPath);
          await vscode.commands.executeCommand('vscode.open', pdfUri);
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
      } else {
        // Open Markdown file
        const doc = await vscode.workspace.openTextDocument(absolutePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        void vscode.window.showInformationMessage(`Chat exported: ${filename}`);
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to export chat',
        error,
      );
    }
  }

  /**
   * Build a self-contained HTML chat export.
   *
   * Layout (under the execution's storage folder):
   *   texra-chat-{date}-{slug}/
   *     index.html           ← TeXRA styling inlined; references ./assets/*
   *     assets/              ← katex.min.css, texmath.css, hljs themes, fonts
   *
   * Opens index.html in the user's default browser so they see the same
   * KaTeX/highlight.js rendering an audience would see.
   */
  private async exportChatAsHtml(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<void> {
    const path = await import('node:path');
    const { formatChatAsHtml } =
      await import('@commands/history/htmlExport/htmlFormatter');

    const folderName = generateExportFolderName(exportInput);
    const folderPath = `executions/${historyId}/${folderName}`;
    const assetsPath = `${folderPath}/assets`;

    // Stage assets BEFORE writing index.html so a missing/failed asset
    // copy can never leave behind an HTML file pointing at empty `./assets`.
    const assetsSrc = path.join(this.extensionPath, 'resources', 'htmlExport');
    const fsExtra = (await import('fs-extra')).default;
    if (!(await fsExtra.pathExists(assetsSrc))) {
      throw new Error(
        `HTML export assets missing at ${assetsSrc} — rebuild the extension ` +
          `(npm run package:fast) so scripts/copy-html-export-assets.mjs runs.`,
      );
    }
    await StorageFS.ensureDir(folderPath);
    await fsExtra.copy(assetsSrc, StorageFS.fullPath(assetsPath), {
      overwrite: true,
    });

    const html = formatChatAsHtml(exportInput);
    await StorageFS.write(`${folderPath}/index.html`, html);

    const htmlAbsolute = StorageFS.fullPath(`${folderPath}/index.html`);
    await vscode.env.openExternal(vscode.Uri.file(htmlAbsolute));
    void vscode.window.showInformationMessage(
      `Chat exported to ${folderName}/index.html`,
    );
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
        await vscode.window.showErrorMessage('History item not found');
        return;
      }
      const config = AgentConfigSchema.parse(raw);
      await action(config);
    } catch (error) {
      await showLoggedErrorMessage(this.ctx.channel, errorPrefix, error);
    }
  }
}
