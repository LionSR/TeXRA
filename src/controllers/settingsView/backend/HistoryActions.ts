import {
  deleteAllExecutions,
  deleteExecution,
  getExecutionStore,
} from '@agent/storage';
import { tryDefaultSession } from '@agent/runtime';
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
import { createLog } from '@logger/logUtils';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ExecutionId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';
import {
  cleanupExecutionAdjacentStreamState,
  openStandaloneStreamStores,
  type AdjacentStreamStores,
} from '@transcript/adjacentStreamCleanup';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('HistoryActions');

type HistoryExportFormat = 'md' | 'tex' | 'html';
export type HistoryOpenKind = 'text' | 'pdf' | 'external';

/**
 * The extension and desktop hosts run `HistoryActions` in the same process
 * as their live `SessionHandle` — reuse its resident `transcripts`/
 * `snapshots` pair so a delete here is immediately visible there too
 * (otherwise the Progress rail's in-memory registry would keep listing a
 * stream whose sidecars were just deleted through a second, independent
 * store pair until the process reloads it). No live session (CLI's one-shot
 * `history` command) falls back to a standalone pair. Either way, a store
 * that fails to open (e.g. one corrupt, unrelated persisted stream) must not
 * block deleting the requested execution — warn once and let the caller
 * proceed with no adjacent-state cleanup for this call.
 */
async function resolveAdjacentStreamStores(): Promise<
  AdjacentStreamStores | undefined
> {
  const session = tryDefaultSession();
  if (session) {
    return { streamLogs: session.transcripts, snapshots: session.snapshots };
  }
  try {
    return await openStandaloneStreamStores();
  } catch (error) {
    log.warn(
      `Could not open the transcript store for history cleanup; deleted executions may leave orphaned sidecars: ${toErrorMessage(error)}`,
      { data: error },
    );
    return undefined;
  }
}

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
}

/** Host-neutral orchestration for the seven history settings actions. */
export class HistoryActions {
  constructor(private readonly ports: HistoryActionPorts) {}

  async postHistoryData(): Promise<void> {
    await this.ports.postMessage(await buildHistoryMessage());
  }

  async deleteItem(historyId: string): Promise<void> {
    const executionId = historyId as ExecutionId;
    const stores = await resolveAdjacentStreamStores();
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
    const stores = await resolveAdjacentStreamStores();
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
