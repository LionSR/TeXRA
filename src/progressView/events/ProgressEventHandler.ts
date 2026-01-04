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
import type { TaskGroup } from '@logger/LogTypes';
import { WebviewUpdater } from '@progressView/managers';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { nestedMapToRecord } from '@progressView/persistence/serializationUtils';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports
import type { StreamStatus } from '@eventBus/ProgressEventBus';
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
  createRetryEvents,
  type RetryEventsModule,
  type RetryEventsShared,
} from './RetryEvents';
import {
  createApprovalEvents,
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
  /**
   * Buffer for task groups that arrive before their stream is activated.
   * Key: stream ID, Value: array of groups waiting to be sent to frontend.
   * Groups are replayed when setActiveStream is processed for the stream.
   */
  private readonly pendingTaskGroups = new Map<string, TaskGroup[]>();
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

    // Modules now use withEventErrorHandling() directly - no error boundary injection needed
    this.streamStatusEvents = createStreamStatusEvents({
      streamStatus: this._streamStatus,
      setStreamStatus: this.setStreamStatus.bind(this),
      sendInstructionUpdate: this.sendInstructionUpdate.bind(this),
      refreshStreamSurface: this.refreshStreamSurface.bind(this),
      debugLog: this.logger.debug.bind(this.logger),
      replayPendingTaskGroups: this.replayPendingTaskGroups.bind(this),
    });
    this.outputEvents = createOutputEvents({});
    this.usageEvents = createUsageEvents({});
    this.logEvents = createLogEvents({});
    this.taskGroupEvents = createTaskGroupEvents({
      initializeStreamForTaskGroup:
        this.initializeStreamForTaskGroup.bind(this),
      debugLog: this.logger.debug.bind(this.logger),
      bufferTaskGroupForReplay: this.bufferTaskGroupForReplay.bind(this),
    });
    this.todoEvents = createTodoEvents({});
    this.retryEvents = createRetryEvents({
      showRetryRequest: callbacks.showRetryRequest,
      resolveRetryRequest: callbacks.resolveRetryRequest,
    });
    this.approvalEvents = createApprovalEvents({
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
      this.webviewUpdater.updateInstruction('', null);
      return;
    }

    const taskState = this.state.getTaskState(stream);
    const instructionUpdate = WebviewUpdater.createInstructionUpdate(taskState);
    const { sessionCategory: sessionKindHint } =
      this.state.getStreamHints(stream);
    const sessionKind =
      taskState?.agentConfig?.session?.agentCategory ?? sessionKindHint;
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

    this.webviewUpdater.updateInstruction(
      stream,
      instructionUpdate ?? null,
      sessionKind,
    );
  }

  /**
   * Refresh all webview surface data for a specific stream.
   * @param options.forceRebuild - If true, frontend will do full DOM rebuild.
   *   Required when switching streams or after data deletion. Defaults to false
   *   for incremental updates.
   * @returns The resolved active run ID, useful for callers that need to pass it
   *   to sendInstructionUpdate separately (when updateInstruction is false).
   */
  public refreshStreamSurface(
    stream: string,
    options: { updateInstruction?: boolean; forceRebuild?: boolean } = {},
  ): string | null {
    if (!this.webviewUpdater.isAvailable()) return null;

    const { updateInstruction = true, forceRebuild = false } = options;

    if (!stream) {
      this.webviewUpdater.updateLogContent('', [], []);
      this.webviewUpdater.updateFiles('', { reset: true });
      this.webviewUpdater.updateMissingOutputs('', { reset: true });
      this.webviewUpdater.updateUsage('', {});
      this.webviewUpdater.updateStatus(STREAM_STATUS.READY);
      if (updateInstruction) {
        this.webviewUpdater.updateInstruction('', null);
      }
      return null;
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

    const filesByRun = nestedMapToRecord(
      this.state.outputFiles.getFiles(stream),
    );
    const missingByRun = nestedMapToRecord(
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

    return activeRunId;
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
    const previousStatus = this._streamStatus.get(stream);

    // Update the persistent status map first
    if (status === STREAM_STATUS.READY) {
      this._streamStatus.delete(stream);
    } else {
      this._streamStatus.set(stream, status);
    }

    if (this.webviewUpdater.isAvailable()) {
      const streamExists = this.state.streamTabs.has(stream);

      // Determine if full refresh is needed:
      // - New stream (not in tabs yet) always needs full refresh
      // - When time-sorted, only refresh if status change might affect order
      const needsFullRefresh =
        !streamExists ||
        (this.state.streamSortOrder === 'time' &&
          this.mightAffectTabOrder(previousStatus, status));

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

  /**
   * Determine if a status transition might affect stream tab ordering.
   * First status assignment or transitions TO running may result in new log
   * activity that changes the stream's position in time-sorted order.
   * Other transitions (RUNNING→STOPPED, etc.) don't require re-sorting because
   * all log timestamps were already captured while the stream was RUNNING.
   */
  private mightAffectTabOrder(
    previous: StreamStatus | undefined,
    current: StreamStatus,
  ): boolean {
    // First status assignment should always trigger refresh
    if (previous === undefined) {
      return true;
    }

    // Transitioning TO running may result in new log activity
    return (
      current === STREAM_STATUS.RUNNING && previous !== STREAM_STATUS.RUNNING
    );
  }

  /**
   * Get a copy of all stream statuses
   */
  getAllStreamStatuses(): Map<string, StreamStatus> {
    return new Map(this._streamStatus);
  }

  /**
   * Buffer a task group for later replay when the stream becomes active.
   * Called by TaskGroupEvents when addTaskGroup arrives before setActiveStream.
   */
  private bufferTaskGroupForReplay(stream: string, group: TaskGroup): void {
    const pending = this.pendingTaskGroups.get(stream) ?? [];
    pending.push(group);
    this.pendingTaskGroups.set(stream, pending);
  }

  /**
   * Replay any buffered task groups for a stream after it becomes active.
   * Called by StreamStatusEvents after setActiveStream sets state.activeStream.
   */
  private replayPendingTaskGroups(
    stream: string,
    updater: WebviewUpdater,
  ): void {
    const pending = this.pendingTaskGroups.get(stream);
    if (!pending || pending.length === 0) {
      return;
    }

    this.logger.debug(
      `Replaying ${pending.length} buffered task groups for stream ${stream}`,
    );
    for (const group of pending) {
      updater.addTaskGroup(stream, group);
    }
    this.pendingTaskGroups.delete(stream);
  }

  /**
   * Initialize a stream when task group events arrive before dedicated
   * status or activation events, preserving any existing status metadata.
   */
  private async initializeStreamForTaskGroup(stream: string): Promise<void> {
    const existingStatus = this._streamStatus.get(stream);

    await this.state.streamTabs.ensureStream(stream);

    // Set status directly without triggering webview update - we do a single
    // coordinated updateAll below to avoid multiple redundant updates.
    if (!existingStatus) {
      this._streamStatus.set(stream, STREAM_STATUS.RUNNING);
    }

    this.state.updateStreamHints(stream, {
      sessionCategory: AgentCategory.Workflow,
    });

    const currentFilter = this.state.agentTypeFilter;
    if (currentFilter !== 'all' && currentFilter !== AgentCategory.Workflow) {
      this.state.agentTypeFilter = AgentCategory.Workflow;
    }

    this.state.activeStream = stream;

    if (this.webviewUpdater.isAvailable()) {
      // Single coordinated update - send UPDATE_STREAMS first so frontend
      // sets state.activeStream. Without this, UPDATE_LOGS fails _isActiveStream check.
      this.webviewUpdater.updateAll(this.state, this._streamStatus);

      // Force rebuild to clear any previous stream's content. The new task
      // group must be added to state BEFORE this call (in TaskGroupEvents)
      // so UPDATE_LOGS includes it and the frontend renders it correctly.
      // Use the returned runId to avoid duplicate resolveRunId call.
      const activeRunId = this.refreshStreamSurface(stream, {
        updateInstruction: false,
        forceRebuild: true,
      });
      this.sendInstructionUpdate(stream, activeRunId);
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
