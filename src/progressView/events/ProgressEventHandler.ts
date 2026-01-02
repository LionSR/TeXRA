// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent and usage types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';
import type { TokenUsageStats } from '@agent/types/UsageTypes';

// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { normalizeRunId } from '@common/constants/runIds';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';
import { WebviewUpdater } from '@progressView/managers';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports
import type { StreamStatus } from '@eventBus/ProgressEventBus';
import { createErrorBoundary } from './errorHandling';
import {
  createStreamStatusEvents,
  type StreamStatusEventModule,
} from './StreamStatusEvents';
import { createOutputEvents, type OutputEventsModule } from './OutputEvents';
import { createUsageEvents, type UsageEventsModule } from './UsageEvents';
import { createLogEvents, type LogEventsModule } from './LogEvents';
import {
  createTaskGroupEvents,
  type TaskGroupEventsModule,
} from './TaskGroupEvents';
import {
  createRetryEventsModule,
  type RetryEventsModule,
  type RetryEventsShared,
} from './RetryEvents';
import {
  createApprovalEventsModule,
  type ApprovalEventsModule,
  type ApprovalEventsShared,
} from './ApprovalEvents';
import { createTodoEvents, type TodoEventsModule } from './TodoEvents';

/**
 * Handles progress event bus subscriptions for the progress view.
 * Provides a clean separation between event handling and business logic
 * by delegating to the state manager and webview updater.
 */
export class ProgressEventHandler {
  private readonly logger: AgentLogger;
  private _streamStatus: Map<string, StreamStatus> = new Map();
  private readonly streamStatusEvents: StreamStatusEventModule;
  private readonly outputEvents: OutputEventsModule;
  private readonly logEvents: LogEventsModule;
  private readonly usageEvents: UsageEventsModule;
  private readonly taskGroupEvents: TaskGroupEventsModule;
  private readonly todoEvents: TodoEventsModule;
  private readonly retryEvents: RetryEventsModule;
  private readonly approvalEvents: ApprovalEventsModule;

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
    callbacks: Pick<
      RetryEventsShared,
      'showRetryRequest' | 'resolveRetryRequest'
    > &
      Pick<
        ApprovalEventsShared,
        | 'showToolEditApprovalPrompt'
        | 'resolveToolEditApprovalPrompt'
        | 'updateToolEditApprovalBypassState'
      >,
  ) {
    this.logger = new AgentLogger('ProgressEventHandler');

    // Create error boundaries centrally - modules receive pre-configured boundaries
    this.streamStatusEvents = createStreamStatusEvents({
      withErrorBoundary: createErrorBoundary(this.logger, 'StreamStatusEvents'),
      streamStatus: this._streamStatus,
      setStreamStatus: (stream, status) => this.setStreamStatus(stream, status),
      sendInstructionUpdate: (stream) => this.sendInstructionUpdate(stream),
      refreshStreamSurface: (stream, options) =>
        this.refreshStreamSurface(stream, options),
      warnLog: (message) => this.logger.warn(message),
      debugLog: (message) => this.logger.debug(message),
    });
    this.outputEvents = createOutputEvents({
      withErrorBoundary: createErrorBoundary(this.logger, 'OutputEvents'),
    });
    this.usageEvents = createUsageEvents({
      withErrorBoundary: createErrorBoundary(this.logger, 'UsageEvents'),
    });
    this.logEvents = createLogEvents({
      withErrorBoundary: createErrorBoundary(this.logger, 'LogEvents'),
    });
    this.taskGroupEvents = createTaskGroupEvents({
      withErrorBoundary: createErrorBoundary(this.logger, 'TaskGroupEvents'),
      initializeStreamForTaskGroup: (stream) =>
        this.initializeStreamForTaskGroup(stream),
      debugLog: (message) => this.logger.debug(message),
    });
    this.todoEvents = createTodoEvents({
      withErrorBoundary: createErrorBoundary(this.logger, 'TodoEvents'),
      debugLog: (message) => this.logger.debug(message),
    });
    this.retryEvents = createRetryEventsModule({
      withErrorBoundary: createErrorBoundary(this.logger, 'RetryEvents'),
      showRetryRequest: callbacks.showRetryRequest,
      resolveRetryRequest: callbacks.resolveRetryRequest,
    });
    this.approvalEvents = createApprovalEventsModule({
      withErrorBoundary: createErrorBoundary(this.logger, 'ApprovalEvents'),
      showToolEditApprovalPrompt: callbacks.showToolEditApprovalPrompt,
      resolveToolEditApprovalPrompt: callbacks.resolveToolEditApprovalPrompt,
      updateToolEditApprovalBypassState:
        callbacks.updateToolEditApprovalBypassState,
    });
  }

  /**
   * Setup all event bus listeners
   */
  setupEventListeners(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    disposables.push(
      ...this.streamStatusEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.outputEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.usageEvents.register(bus, this.state, this.webviewUpdater),
    );
    // Task group events must be registered before log events so buffered group
    // replays run first. Otherwise replayed thinking logs land before their
    // containers exist, leaving the progress board with orphaned banners.
    disposables.push(
      ...this.taskGroupEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.logEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.todoEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(...this.retryEvents.register(bus));
    disposables.push(...this.approvalEvents.register(bus));
    disposables.push(
      new vscode.Disposable(
        bus.on('extensionDeactivating', () =>
          this.markAllRunningTasksAsCancelled(),
        ),
      ),
    );

    return disposables;
  }

  /**
   * Send instruction updates for the provided stream
   */
  private sendInstructionUpdate(
    stream: StreamTabId | '',
    runIdHint?: string | null,
  ): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    if (!stream) {
      this.webviewUpdater.clearInstruction('');
      return;
    }

    const taskState = this.state.getTaskState(stream);
    const instructionUpdate = WebviewUpdater.createInstructionUpdate(taskState);
    const { sessionCategory: sessionKindHint } =
      this.state.getStreamHints(stream);
    const sessionKind = taskState?.session?.agentCategory ?? sessionKindHint;
    const runId =
      runIdHint === undefined
        ? this.state.resolveRunId(stream, undefined, {
            persist: false,
          })
        : runIdHint;

    if (runId && instructionUpdate) {
      void this.state.runInstructions.setInstruction(
        stream,
        normalizeRunId(runId),
        instructionUpdate,
      );
    } else if (runId) {
      void this.state.runInstructions.deleteRun(stream, normalizeRunId(runId));
    }

    if (instructionUpdate) {
      this.webviewUpdater.updateInstruction(
        stream,
        instructionUpdate,
        sessionKind,
      );
    } else {
      this.webviewUpdater.clearInstruction(stream);
    }
  }

  /**
   * Refresh all webview surface data for a specific stream.
   * @param options.forceRebuild - If true, frontend will do full DOM rebuild.
   *   Required when switching streams or after data deletion. Defaults to false
   *   for incremental updates.
   */
  public refreshStreamSurface(
    stream: string,
    options: { updateInstruction?: boolean; forceRebuild?: boolean } = {},
  ): void {
    if (!this.webviewUpdater.isAvailable()) return;

    const { updateInstruction = true, forceRebuild = false } = options;

    if (!stream) {
      this.webviewUpdater.updateLogContent('', [], []);
      this.webviewUpdater.updateFiles('', { reset: true });
      this.webviewUpdater.updateMissingOutputs('', { reset: true });
      this.webviewUpdater.updateUsage('', {});
      this.webviewUpdater.updateStatus(STREAM_STATUS.READY);
      if (updateInstruction) {
        this.webviewUpdater.clearInstruction('');
      }
      return;
    }

    const messages = this.state.streamTabs.getMessages(stream);
    const groups = Array.from(
      this.state.taskGroups.getStreamGroups(stream).values(),
    );
    const activeRunId = this.state.resolveRunId(stream, undefined, {
      persist: false,
    });

    const runInstructions = Object.fromEntries(
      this.state.runInstructions.getInstructions(stream).entries(),
    );

    const filesByRun = this.formatRunOutputs(
      this.state.outputFiles.getFiles(stream),
    );
    const missingByRun = this.formatRunStringOutputs(
      this.state.outputFiles.getMissingOutputs(stream),
    );
    const usageByRun = Object.fromEntries(
      this.state.usageStats.getRunUsage(stream).entries(),
    ) as Record<string, TokenUsageStats>;

    this.webviewUpdater.updateLogContent(
      stream,
      messages,
      groups,
      {
        runInstructions,
        activeRunId,
        runUsage: usageByRun,
        runFiles: filesByRun,
      },
      { forceRebuild },
    );

    // Note: Files are already included in UPDATE_LOGS (runFiles) and handled
    // by handleUpdateLogs in the frontend. We don't send separate UPDATE_FILES
    // messages here to avoid a race condition where reset: true would clear
    // the files just populated from UPDATE_LOGS.

    this.webviewUpdater.updateMissingOutputs(stream, { reset: true });
    Object.entries(missingByRun).forEach(([runId, rounds]) => {
      this.webviewUpdater.updateMissingOutputs(stream, {
        runId,
        rounds,
      });
    });

    // Refresh todos for the stream (ephemeral state)
    // Always send todos if defined (including empty array to clear stale UI)
    const todos = this.state.getTodos(stream);
    if (todos !== undefined) {
      this.webviewUpdater.updateTodos(stream, todos);
    }

    // Update status for current stream - default to STOPPED when stream exists but no status is set
    const status = this._streamStatus.get(stream) || STREAM_STATUS.STOPPED;
    this.webviewUpdater.updateStatus(status);

    if (updateInstruction) {
      this.sendInstructionUpdate(stream, activeRunId);
    }
  }

  /**
   * Get current stream status
   */
  getStreamStatus(stream: string): StreamStatus | undefined {
    return this._streamStatus.get(stream);
  }

  /**
   * Set the status for a specific stream synchronously.
   */
  setStreamStatus(stream: string, status: StreamStatus): void {
    // Update the persistent status map first
    if (status === STREAM_STATUS.READY) {
      this._streamStatus.delete(stream);
    } else {
      this._streamStatus.set(stream, status);
    }

    if (this.webviewUpdater.isAvailable()) {
      // When sorted by time, status changes may affect tab order (due to new log entries),
      // so we need a full refresh. Otherwise use efficient targeted update.
      const needsFullRefresh =
        !this.state.streamTabs.has(stream) ||
        this.state.streamSortOrder === 'time';

      if (needsFullRefresh) {
        // Include current status in refresh map so frontend displays it correctly.
        // READY is deleted from _streamStatus but should still be shown to user.
        const statusesForRefresh = new Map(this._streamStatus);
        statusesForRefresh.set(stream, status);
        this.webviewUpdater.updateAll(this.state, statusesForRefresh);
      } else {
        // Targeted update - frontend handles main status update via handleUpdateStreamStatus
        const logs = this.state.streamTabs.getMessages(stream);
        // Note: lastTimestamp may be undefined if logs exist but last entry has no timestamp.
        // Frontend guards against invalid timestamps (0, undefined) with lastTimestamp > 0 check.
        const lastTimestamp =
          logs.length > 0 ? logs.at(-1)?.timestamp : undefined;
        this.webviewUpdater.updateStreamStatus(stream, status, lastTimestamp);
      }
    }
  }

  private formatRunOutputs(
    runs: Map<string, Map<number, OutputFileInfo[]>>,
  ): Record<string, { [key: number]: OutputFileInfo[] }> {
    const payload: Record<string, { [key: number]: OutputFileInfo[] }> = {};
    for (const [runId, rounds] of runs.entries()) {
      payload[runId] = Object.fromEntries(rounds.entries());
    }
    return payload;
  }

  private formatRunStringOutputs(
    runs: Map<string, Map<number, string[]>>,
  ): Record<string, { [key: number]: string[] }> {
    const payload: Record<string, { [key: number]: string[] }> = {};
    for (const [runId, rounds] of runs.entries()) {
      payload[runId] = Object.fromEntries(rounds.entries());
    }
    return payload;
  }

  /**
   * Get a copy of all stream statuses
   */
  getAllStreamStatuses(): Map<string, StreamStatus> {
    return new Map(this._streamStatus);
  }

  /**
   * Initialize a stream when task group events arrive before dedicated
   * status or activation events, preserving any existing status metadata.
   */
  private async initializeStreamForTaskGroup(stream: string): Promise<void> {
    const existingStatus = this._streamStatus.get(stream);

    await this.state.streamTabs.ensureStream(stream);

    if (!existingStatus) {
      this.setStreamStatus(stream, STREAM_STATUS.RUNNING);
    }

    this.state.updateStreamHints(stream, {
      sessionCategory: AgentCategory.Workflow,
    });

    const currentFilter = this.state.agentTypeFilter;
    if (currentFilter !== 'all' && currentFilter !== AgentCategory.Workflow) {
      this.state.agentTypeFilter = AgentCategory.Workflow;
    }

    this.state.activeStream = stream;

    const status = this._streamStatus.get(stream) ?? STREAM_STATUS.RUNNING;
    this.setStreamStatus(stream, status);

    if (this.webviewUpdater.isAvailable()) {
      // Force rebuild to clear any previous stream's content. The new task
      // group must be added to state BEFORE this call (in TaskGroupEvents)
      // so UPDATE_LOGS includes it and the frontend renders it correctly.
      this.refreshStreamSurface(stream, {
        updateInstruction: false,
        forceRebuild: true,
      });
      this.sendInstructionUpdate(stream);
    }
  }

  /**
   * Mark all running tasks as cancelled (used during restart)
   */
  markAllRunningTasksAsCancelled(): void {
    for (const [stream, status] of this._streamStatus.entries()) {
      if (status === STREAM_STATUS.RUNNING) {
        this._streamStatus.set(stream, STREAM_STATUS.STOPPED);
      }
    }
  }

  /**
   * Reset running tasks to ERROR status (used during webview reload)
   * Returns the list of affected streams for further processing
   */
  resetRunningTasksToError(waitingStreams?: Set<string>): string[] {
    const affectedStreams: string[] = [];
    const waitingSet = waitingStreams ?? new Set<string>();

    for (const [stream, status] of this._streamStatus.entries()) {
      if (status === STREAM_STATUS.RUNNING) {
        if (waitingSet.has(stream)) {
          this._streamStatus.set(stream, STREAM_STATUS.WAITING);
          this.logger.debug(
            `Stream ${stream} restored to WAITING after reload`,
          );
        } else {
          this._streamStatus.set(stream, STREAM_STATUS.ERROR);
          affectedStreams.push(stream);
          this.logger.debug(
            `Stream ${stream} set to ERROR due to webview reload`,
          );
        }
      }
    }

    return affectedStreams;
  }
}
