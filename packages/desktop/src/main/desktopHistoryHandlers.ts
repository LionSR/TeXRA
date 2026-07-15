// Node.js imports
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Local imports - history domain
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import {
  deleteAllExecutions,
  deleteExecution,
  getExecutionStore,
} from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import type { TaskState } from '@agent/core/state/TaskState';
import { getAllActiveExecutionIds } from '@agent/runtime/SessionHandle';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';

// Local imports - IPC contracts
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ExecutionId } from '@shared/schemas';

// Local imports - controller types
import type {
  ChatExportController,
  ExportInputStatus,
} from '@controllers/settingsView/ChatExportController';
import type { SettingsViewCommandActions } from '@controllers/settingsView/SettingsViewCommandHandlers';

type HistoryExportFormat = 'md' | 'tex' | 'html';

/** History-specific capabilities supplied by the desktop host. */
export interface DesktopHistoryOptions {
  /** Resolved extension resources used by chat export templates. */
  readonly resourcesPath: string;
  /** Run a validated request created from a persisted history entry. */
  readonly runExecution: (request: ValidatedExecutionRequest) => Promise<void>;
  /** Restore a persisted agent configuration into the main view. */
  readonly restoreTaskState: (taskState: TaskState) => Promise<boolean>;
  readonly postToRenderer: (message: unknown) => void;
  readonly openPath: (filePath: string) => Promise<void>;
  readonly showInfoMessage: (message: string) => Promise<void>;
  readonly showErrorMessage: (message: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

const HISTORY_CONFIG_UNREADABLE_MESSAGE =
  'History item not found or unreadable (missing, corrupt, or from an incompatible version)';

type HistoryConfigResult =
  { status: 'ok'; config: AgentConfig } | { status: 'unreadable' };

export interface DesktopHistorySettingsController {
  readonly actions: SettingsViewCommandActions['history'];
  postHistoryData(): Promise<void>;
}

/** Own desktop history settings actions behind the dispatcher contract. */
export class DesktopHistoryHandlers implements DesktopHistorySettingsController {
  readonly actions: SettingsViewCommandActions['history'];

  private chatExportControllerLoad: Promise<ChatExportController> | undefined;

  constructor(private readonly dependencies: DesktopHistoryOptions) {
    this.actions = {
      deleteAgent: (historyId) => this.deleteItem(historyId),
      clear: () => this.clear(),
      rerunAgent: (data) => this.rerun(data.historyId),
      restoreAgent: (data) => this.restore(data.historyId),
      exportChatMd: (data) => this.exportChat(data.historyId, 'md'),
      exportChatTex: (data) => this.exportChat(data.historyId, 'tex'),
      exportChatHtml: (data) => this.exportChat(data.historyId, 'html'),
    };
  }

  async postHistoryData(): Promise<void> {
    this.dependencies.postToRenderer(await buildHistoryMessage());
  }

  private async deleteItem(historyId: string): Promise<void> {
    if (getAllActiveExecutionIds().includes(historyId)) {
      await this.dependencies.showInfoMessage(
        'Cannot delete a running execution',
      );
      return;
    }

    const deleted = await deleteExecution(historyId as ExecutionId);
    if (!deleted) {
      await this.dependencies.showInfoMessage(
        `History item not found: ${historyId}`,
      );
      return;
    }
    await this.postHistoryData();
  }

  private async clear(): Promise<void> {
    await deleteAllExecutions(new Set(getAllActiveExecutionIds()));
    this.dependencies.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
    });
  }

  // readConfig() validates and returns null for missing and corrupt configs;
  // distinguishing them must happen in the storage layer, not here.
  private async readHistoryConfig(
    historyId: string,
  ): Promise<HistoryConfigResult> {
    const config = await getExecutionStore(
      historyId as ExecutionId,
    ).readConfig();
    if (!config) return { status: 'unreadable' };
    return { status: 'ok', config };
  }

  private async rerun(historyId: string): Promise<void> {
    const result = await this.readHistoryConfig(historyId);
    if (result.status === 'unreadable') {
      await this.dependencies.showErrorMessage(
        HISTORY_CONFIG_UNREADABLE_MESSAGE,
      );
      return;
    }
    const validated = validateExecutionRequest({ config: result.config });
    if (!validated.valid) {
      await this.dependencies.showErrorMessage(validated.message);
      return;
    }
    await this.dependencies.showInfoMessage('Rerunning agent from history');
    await this.dependencies.runExecution(validated.request);
  }

  private async restore(historyId: string): Promise<void> {
    const result = await this.readHistoryConfig(historyId);
    if (result.status === 'unreadable') {
      await this.dependencies.showErrorMessage(
        HISTORY_CONFIG_UNREADABLE_MESSAGE,
      );
      return;
    }
    const restored = await this.dependencies.restoreTaskState(
      agentConfigToTaskState(result.config),
    );
    if (!restored) {
      await this.dependencies.showErrorMessage(
        'Failed to restore configuration',
      );
    }
  }

  private getChatExportController(): Promise<ChatExportController> {
    this.chatExportControllerLoad ??=
      import('@controllers/settingsView/ChatExportController')
        .then(({ ChatExportController }) => {
          const latexPreamble = readFileSync(
            path.join(
              this.dependencies.resourcesPath,
              'templates',
              'chatExport.tex',
            ),
            'utf8',
          );
          return new ChatExportController({ latexPreamble });
        })
        .catch((error: unknown) => {
          this.chatExportControllerLoad = undefined;
          throw error;
        });
    return this.chatExportControllerLoad;
  }

  private async reportExportInputError(
    status: Exclude<ExportInputStatus, 'ok'>,
  ): Promise<void> {
    switch (status) {
      case 'config_missing':
        await this.dependencies.showInfoMessage('History item not found');
        return;
      case 'conversation_missing':
        await this.dependencies.showInfoMessage(
          'No conversation data available for this execution',
        );
        return;
    }
  }

  private async reportHtmlExportError(
    status: 'config_missing' | 'streamLogs_missing',
  ): Promise<void> {
    switch (status) {
      case 'config_missing':
        await this.dependencies.showInfoMessage('History item not found');
        return;
      case 'streamLogs_missing':
        await this.dependencies.showInfoMessage(
          'No stored transcript available for this execution — it may predate transcript persistence.',
        );
        return;
    }
  }

  private async exportChatHtml(historyId: string): Promise<void> {
    const controller = await this.getChatExportController();
    const outcome = await controller.exportAsHtml(
      historyId,
      path.join(
        this.dependencies.resourcesPath,
        'traceViewerStandalone',
        'index.html',
      ),
    );
    if (outcome.status !== 'ok') {
      await this.reportHtmlExportError(outcome.status);
      return;
    }
    const { absolutePath, storagePath } = outcome.result;
    await this.dependencies.openPath(absolutePath);
    await this.dependencies.showInfoMessage(
      `Chat exported: ${path.basename(storagePath)}`,
    );
  }

  private async exportChat(
    historyId: string,
    format: HistoryExportFormat,
  ): Promise<void> {
    if (format === 'html') {
      await this.exportChatHtml(historyId);
      return;
    }

    const controller = await this.getChatExportController();
    const result = await controller.buildExportInput(historyId);
    if (result.status !== 'ok') {
      await this.reportExportInputError(result.status);
      return;
    }
    const { exportInput } = result;

    if (format === 'md') {
      const { absolutePath, storagePath } = await controller.exportAsMarkdown(
        historyId,
        exportInput,
      );
      await this.dependencies.openPath(absolutePath);
      await this.dependencies.showInfoMessage(
        `Chat exported: ${path.basename(storagePath)}`,
      );
      return;
    }

    const { absolutePath, storagePath, pdfPath, logTail } =
      await controller.exportAsLatex(historyId, exportInput);
    if (pdfPath) {
      await this.dependencies.openPath(pdfPath);
      await this.dependencies.showInfoMessage(
        `Chat exported and compiled: ${path.basename(storagePath).replace('.tex', '.pdf')}`,
      );
      return;
    }
    if (logTail) {
      this.dependencies.onError(
        new Error(
          `LaTeX export compilation failed for ${storagePath}:\n${logTail}`,
        ),
      );
    }
    await this.dependencies.openPath(absolutePath);
    await this.dependencies.showInfoMessage(
      'LaTeX compilation failed. The .tex source file has been opened instead.',
    );
  }
}
