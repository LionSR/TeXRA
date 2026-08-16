import {
  deleteAllExecutions,
  deleteExecution,
  getExecutionStore,
} from '@agent/storage';
import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  type ValidatedExecutionRequest,
  validateExecutionRequest,
} from '@agent/core/state/executionRequests';
import {
  type ChatExportController,
  type ChatExportInput,
} from '@controllers/settingsView/ChatExportController';
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
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ExecutionId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';
import {
  cleanupExecutionAdjacentStreamState,
  resolveAdjacentStreamStores,
  type AdjacentStreamStores,
} from '@transcript/adjacentStreamCleanup';

type HistoryExportFormat = 'md' | 'tex' | 'html';
export type HistoryOpenKind = 'text' | 'pdf' | 'external';

export interface HistoryActionPorts {
  getChatExportController(): Promise<ChatExportController>;
  readonly traceViewerTemplate: string;
  runExecution(request: ValidatedExecutionRequest): Promise<void>;
  restoreRunConfig(config: AgentConfig): Promise<boolean | void>;
  postMessage(message: unknown): Promise<void> | void;
  openPath(filePath: string, kind: HistoryOpenKind): Promise<void>;
  showInfo(message: string): Promise<void>;
  showWarning(message: string): Promise<void>;
  showError(message: string): Promise<void>;
  confirm(message: string, confirmLabel: string): Promise<boolean>;
  reportDetail(message: string, data?: unknown): void;
  /**
   * The host's live session's transcript/snapshot pair, if one is running —
   * reused so a delete here is immediately visible there too. Without this,
   * `HistoryActions` would open a second, independent store pair, and the
   * live session's in-memory registry would keep listing a stream whose
   * sidecars this class just deleted, until the process later reloads it.
   * Neither host can be assumed to have a globally-reachable default
   * session (desktop's process session in particular is never registered as
   * one), so each host provides this explicitly rather than `HistoryActions`
   * reaching for one itself. Return `undefined` when no session is running.
   */
  getLiveStreamStores?(): AdjacentStreamStores | undefined;
}

/** Host-neutral orchestration for the seven history settings actions. */
export class HistoryActions {
  constructor(private readonly ports: HistoryActionPorts) {}

  async postHistoryData(): Promise<void> {
    await this.ports.postMessage(await buildHistoryMessage());
  }

  async deleteItem(historyId: string): Promise<void> {
    const executionId = historyId as ExecutionId;
    const stores = await resolveAdjacentStreamStores(
      this.ports.getLiveStreamStores?.(),
    );
    const outcome = describeDeleteExecutionResult(
      await deleteExecution(executionId, {
        beforeDelete: stores
          ? () => cleanupExecutionAdjacentStreamState(executionId, stores)
          : undefined,
      }),
    );
    if (outcome.kind !== 'deleted') {
      await this.ports.showWarning(
        outcome.kind === 'active'
          ? ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE
          : outcome.message,
      );
      return;
    }
    await GoalStore.forgetByExecutionIds([executionId]);
    await this.postHistoryData();
  }

  async clear(): Promise<void> {
    if (
      !(await this.ports.confirm(
        CLEAR_HISTORY_CONFIRM_MESSAGE,
        CLEAR_HISTORY_CONFIRM_LABEL,
      ))
    ) {
      return;
    }
    const stores = await resolveAdjacentStreamStores(
      this.ports.getLiveStreamStores?.(),
    );
    const result = await deleteAllExecutions({
      beforeDelete: stores
        ? (executionId) =>
            cleanupExecutionAdjacentStreamState(executionId, stores)
        : undefined,
    });
    await GoalStore.forgetByExecutionIds(result.deleted);
    const outcome = describeClearHistoryResult(result);
    if (outcome.kind === 'cleared') {
      await this.ports.showInfo(HISTORY_CLEARED_MESSAGE);
      await this.ports.postMessage({
        command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
      });
      return;
    }
    await this.ports.showInfo(outcome.message);
    await this.postHistoryData();
  }

  async rerun(historyId: string): Promise<void> {
    const config = await this.readHistoryConfig(historyId);
    if (!config) return;
    const validated = validateExecutionRequest({ config });
    if (!validated.valid) {
      await this.ports.showError(validated.message);
      return;
    }
    await this.ports.showInfo('Rerunning agent from history');
    await this.ports.runExecution(validated.request);
  }

  async restore(historyId: string): Promise<void> {
    const config = await this.readHistoryConfig(historyId);
    if (!config) return;
    if ((await this.ports.restoreRunConfig(config)) === false) {
      await this.ports.showError('Failed to restore configuration');
    }
  }

  async exportChat(
    historyId: string,
    format: HistoryExportFormat,
  ): Promise<void> {
    const controller = await this.ports.getChatExportController();
    if (format === 'html') {
      await this.exportHtml(controller, historyId);
      return;
    }
    const result = await controller.buildExportInput(historyId);
    if (result.status !== 'ok') {
      await this.ports.showError(exportInputErrorMessage(result.status));
      return;
    }
    if (format === 'md') {
      await this.exportMarkdown(controller, historyId, result.exportInput);
      return;
    }
    await this.exportLatex(controller, historyId, result.exportInput);
  }

  private async readHistoryConfig(
    historyId: string,
  ): Promise<AgentConfig | undefined> {
    const config = await getExecutionStore(
      historyId as ExecutionId,
    ).readConfig();
    if (!config) await this.ports.showError(HISTORY_CONFIG_UNREADABLE_MESSAGE);
    return config ?? undefined;
  }

  private async exportMarkdown(
    controller: ChatExportController,
    historyId: string,
    input: ChatExportInput,
  ): Promise<void> {
    const result = await controller.exportAsMarkdown(historyId, input);
    await this.ports.openPath(result.absolutePath, 'text');
    await this.ports.showInfo(exportedFileMessage(result.storagePath));
  }

  private async exportLatex(
    controller: ChatExportController,
    historyId: string,
    input: ChatExportInput,
  ): Promise<void> {
    const result = await controller.exportAsLatex(historyId, input);
    const outcome = describeLatexExportResult(result);
    if (outcome.kind === 'compileFailed' && outcome.logDetail) {
      this.ports.reportDetail(outcome.logDetail, {
        storagePath: result.storagePath,
        logTail: result.logTail,
      });
    }
    await this.ports.openPath(
      outcome.pathToOpen,
      outcome.kind === 'compiled' ? 'pdf' : 'text',
    );
    await (outcome.kind === 'compiled'
      ? this.ports.showInfo(outcome.message)
      : this.ports.showWarning(outcome.message));
  }

  private async exportHtml(
    controller: ChatExportController,
    historyId: string,
  ): Promise<void> {
    const outcome = await controller.exportAsHtml(
      historyId,
      this.ports.traceViewerTemplate,
    );
    if (outcome.status !== 'ok') {
      await this.ports.showError(htmlExportErrorMessage(outcome.status));
      return;
    }
    await this.ports.openPath(outcome.result.absolutePath, 'external');
    await this.ports.showInfo(exportedFileMessage(outcome.result.storagePath));
  }
}
