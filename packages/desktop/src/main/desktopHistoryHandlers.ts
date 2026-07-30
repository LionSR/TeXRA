// Node imports
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Local imports
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
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import type { ChatExportController } from '@controllers/settingsView/ChatExportController';
import {
  ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
  describeClearHistoryResult,
  describeDeleteExecutionResult,
  describeLatexExportResult,
  exportedFileMessage,
  exportInputErrorMessage,
  htmlExportErrorMessage,
} from '@controllers/settingsView/HistoryActionOutcomes';
import type { SettingsViewCommandActions } from '@controllers/settingsView/SettingsViewCommandHandlers';
import type { ExecutionId } from '@shared/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

type HistoryExportFormat = 'md' | 'tex' | 'html';

/** Dependencies required by the desktop history controller. */
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
    const result = await deleteExecution(historyId as ExecutionId);
    const outcome = describeDeleteExecutionResult(result);
    switch (outcome.kind) {
      case 'active':
        await this.dependencies.showInfoMessage(
          ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
        );
        return;
      case 'not-found':
        await this.dependencies.showInfoMessage(outcome.message);
        return;
      case 'deleted':
        await this.postHistoryData();
        return;
    }
  }

  private async clear(): Promise<void> {
    const result = await deleteAllExecutions();
    const outcome = describeClearHistoryResult(result);
    if (outcome.kind === 'cleared') {
      this.dependencies.postToRenderer({
        command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
      });
      return;
    }
    await this.dependencies.showInfoMessage(outcome.message);
    await this.postHistoryData();
  }

  // readConfig() validates and returns null for missing and corrupt configs;
  // distinguishing them must happen in the storage layer, not here.
  private async readHistoryConfig(
    historyId: string,
  ): Promise<AgentConfig | undefined> {
    const config = await getExecutionStore(
      historyId as ExecutionId,
    ).readConfig();
    if (!config) {
      await this.dependencies.showErrorMessage(
        HISTORY_CONFIG_UNREADABLE_MESSAGE,
      );
      return undefined;
    }
    return config;
  }

  private async rerun(historyId: string): Promise<void> {
    const config = await this.readHistoryConfig(historyId);
    if (!config) return;
    const validated = validateExecutionRequest({ config });
    if (!validated.valid) {
      await this.dependencies.showErrorMessage(validated.message);
      return;
    }
    await this.dependencies.showInfoMessage('Rerunning agent from history');
    void this.dependencies
      .runExecution(validated.request)
      .catch(this.dependencies.onError);
  }

  private async restore(historyId: string): Promise<void> {
    const config = await this.readHistoryConfig(historyId);
    if (!config) return;
    const restored = await this.dependencies.restoreTaskState(
      agentConfigToTaskState(config),
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
      await this.dependencies.showInfoMessage(
        htmlExportErrorMessage(outcome.status),
      );
      return;
    }
    const { absolutePath, storagePath } = outcome.result;
    await this.dependencies.openPath(absolutePath);
    await this.dependencies.showInfoMessage(exportedFileMessage(storagePath));
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
      await this.dependencies.showInfoMessage(
        exportInputErrorMessage(result.status),
      );
      return;
    }
    const { exportInput } = result;

    if (format === 'md') {
      const { absolutePath, storagePath } = await controller.exportAsMarkdown(
        historyId,
        exportInput,
      );
      await this.dependencies.openPath(absolutePath);
      await this.dependencies.showInfoMessage(exportedFileMessage(storagePath));
      return;
    }

    const latexResult = await controller.exportAsLatex(historyId, exportInput);
    const outcome = describeLatexExportResult(latexResult);
    if (outcome.kind === 'compileFailed' && outcome.logDetail) {
      this.dependencies.onError(new Error(outcome.logDetail));
    }
    await this.dependencies.openPath(outcome.pathToOpen);
    await this.dependencies.showInfoMessage(outcome.message);
  }
}
