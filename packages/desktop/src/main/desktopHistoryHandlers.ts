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
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import type { ChatExportController } from '@controllers/settingsView/ChatExportController';
import {
  ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
  describeClearHistoryResult,
  describeDeleteExecutionResult,
  describeLatexExportResult,
  exportedFileMessage,
  exportInputErrorMessage,
  HISTORY_CLEARED_MESSAGE,
  HISTORY_CONFIG_UNREADABLE_MESSAGE,
  htmlExportErrorMessage,
} from '@controllers/settingsView/HistoryActionOutcomes';
import type {
  ExecutionId,
  SettingsViewInboundHandlerRegistry,
} from '@shared/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GoalStore } from '@tools/goal';

type HistoryExportFormat = 'md' | 'tex' | 'html';
type DesktopHistoryHandlerRegistry = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.RERUN_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.RESTORE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY
  | typeof SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD
  | typeof SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX
  | typeof SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML
>;

/** Dependencies required by the desktop history controller. */
export interface DesktopHistoryOptions {
  /** Resolved extension resources used by chat export templates. */
  readonly resourcesPath: string;
  /** Run a validated request created from a persisted history entry. */
  readonly runExecution: (request: ValidatedExecutionRequest) => Promise<void>;
  /** Restore a persisted agent configuration into the main view. */
  readonly restoreRunConfig: (config: AgentConfig) => Promise<boolean>;
  readonly postToRenderer: (message: unknown) => void;
  readonly openPath: (filePath: string) => Promise<void>;
  readonly showInfoMessage: (message: string) => Promise<void>;
  /** Surface for an action that did not happen, such as a refused delete. */
  readonly showWarningMessage: (message: string) => Promise<void>;
  readonly showErrorMessage: (message: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export interface DesktopHistorySettingsController {
  readonly handlers: DesktopHistoryHandlerRegistry;
  postHistoryData(): Promise<void>;
}

/** Own desktop history settings actions behind the dispatcher contract. */
export class DesktopHistoryHandlers implements DesktopHistorySettingsController {
  readonly handlers: DesktopHistoryHandlerRegistry;

  private chatExportControllerLoad: Promise<ChatExportController> | undefined;

  constructor(private readonly dependencies: DesktopHistoryOptions) {
    this.handlers = {
      deleteAgent: (message) => this.deleteItem(message.historyId),
      clearHistory: () => this.clear(),
      rerunAgent: (message) => this.rerun(message.historyId),
      restoreAgent: (message) => this.restore(message.historyId),
      exportChatMd: (message) => this.exportChat(message.historyId, 'md'),
      exportChatTex: (message) => this.exportChat(message.historyId, 'tex'),
      exportChatHtml: (message) => this.exportChat(message.historyId, 'html'),
    };
  }

  async postHistoryData(): Promise<void> {
    this.dependencies.postToRenderer(await buildHistoryMessage());
  }

  private async deleteItem(historyId: string): Promise<void> {
    const executionId = historyId as ExecutionId;
    const result = await deleteExecution(executionId);
    const outcome = describeDeleteExecutionResult(result);
    switch (outcome.kind) {
      case 'active':
        await this.dependencies.showWarningMessage(
          ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
        );
        return;
      case 'not-found':
        await this.dependencies.showWarningMessage(outcome.message);
        return;
      case 'deleted':
        await GoalStore.forgetByExecutionIds([executionId]);
        await this.postHistoryData();
        return;
    }
  }

  private async clear(): Promise<void> {
    const result = await deleteAllExecutions();
    await GoalStore.forgetByExecutionIds(result.deleted);
    const outcome = describeClearHistoryResult(result);
    if (outcome.kind === 'cleared') {
      await this.dependencies.showInfoMessage(HISTORY_CLEARED_MESSAGE);
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
    const restored = await this.dependencies.restoreRunConfig(config);
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
