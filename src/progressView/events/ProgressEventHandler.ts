// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { StreamTabId, StorageKey } from '@agent/types/IdentifierTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';

// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { StreamStatus } from '@common/constants/streamStatus';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import type { TaskGroup } from '@logger/LogTypes';
import { AgentLogger } from '@logger/AgentLogger';
import { WebviewUpdater } from '@progressView/managers';
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { nestedMapToRecord } from '@progressView/persistence/serializationUtils';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports - domain event handlers
import { canUpdateWebview, type EventHandlerContext } from './EventHandlerContext';
import { registerLogEventHandlers } from './LogEventHandlers';
import { registerOutputEventHandlers } from './OutputEventHandlers';
import { registerUsageEventHandlers } from './UsageEventHandlers';
import { registerTodoEventHandlers } from './TodoEventHandlers';
import { registerUIEvents, type UICallbacks } from './UIEvents';
import { withEventErrorHandling } from './errorHandling';

// Re-export for consumers
export type { UICallbacks };

/**
 * Handles progress event bus subscriptions for the progress view.
 * Provides a clean separation between event handling and business logic
 * by delegating to the state manager and webview updater.
 */
export class ProgressEventHandler {
  private readonly logger: AgentLogger;
  /**
   * Buffer for task groups that arrive before their stream is activated.
   * Key: stream ID, Value: array of groups waiting to be sent to frontend.
   * Groups are replayed when setActiveStream is processed for the stream.
   */
  private readonly pendingTaskGroups = new Map<string, TaskGroup[]>();

  /** Shared context for domain handlers - used for canUpdateWebview checks */
  private readonly ctx: EventHandlerContext;

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
    private readonly uiCallbacks: UICallbacks,
  ) {
    this.logger = new AgentLogger('ProgressEventHandler');
    this.ctx = { state: this.state, webviewUpdater: this.webviewUpdater };
  }

  /**
   * Update agentTypeFilter to match the session category if needed.
   * Only updates when filter is not 'all' and doesn't already match.
   */
  private maybeUpdateFilterForCategory(
    category: AgentCategory | undefined,
  ): void {
    if (
      category &&
      this.state.agentTypeFilter !== 'all' &&
      this.state.agentTypeFilter !== category
    ) {
      this.state.agentTypeFilter = category;
    }
  }

  /**
   * Setup all event bus listeners.
   * Uses AbortController for cleanup - single dispose aborts all listeners.
   *
   * Event handling is split into focused domain handlers:
   * - Core stream/task events: handled inline (stream lifecycle)
   * - Log events: LogEventHandlers.ts
   * - Output events: OutputEventHandlers.ts
   * - Usage events: UsageEventHandlers.ts
   * - Todo events: TodoEventHandlers.ts
   * - UI events: UIEvents.ts
   */
  setupEventListeners(): vscode.Disposable[] {
    const controller = new AbortController();
    const { signal } = controller;

    // Core stream/task events (handled inline - stream lifecycle)
    bus.on('setActiveStream', this.handleSetActiveStream, { signal });
    bus.on('updateStreamStatus', this.handleUpdateStreamStatus, { signal });
    bus.on('setTaskState', this.handleSetTaskState, { signal });
    bus.on('addTaskGroup', this.handleAddTaskGroup, { signal });
    bus.on('updateTaskGroup', this.handleUpdateTaskGroup, { signal });
    bus.on('extensionDeactivating', this.markAllRunningTasksAsCancelled, {
      signal,
    });

    // Domain-specific event handlers (modular, focused files)
    registerLogEventHandlers(bus, this.ctx, signal);
    registerOutputEventHandlers(bus, this.ctx, signal);
    registerUsageEventHandlers(bus, this.ctx, signal);
    registerTodoEventHandlers(bus, this.ctx, signal);
    registerUIEvents(bus, this.uiCallbacks, signal);

    // Single disposable that cleans up everything
    return [new vscode.Disposable(() => controller.abort())];
  }

  // Event handlers - arrow functions to preserve `this`
  private handleSetActiveStream = (
    payload: ProgressEventPayloads['setActiveStream'],
  ): void => {
    withEventErrorHandling(
      'StreamStatus',
      'failed to handle setActiveStream',
      async () => {
        const { stream, session, isRemote, hasMultipleOutputs } = payload;
        if (!stream) return;

        await this.state.streamTabs.ensureStream(stream);
        this.state.updateStreamHints(stream, {
          sessionCategory: session?.agentCategory,
          isRemote,
          hasMultipleOutputs,
        });
        this.maybeUpdateFilterForCategory(session?.agentCategory);
        this.state.activeStream = stream;
        this.replayPendingTaskGroups(stream);

        // Get current status without defaulting to RUNNING.
        // Status should only be set to RUNNING by setupFlowUIState in executeAgent,
        // not here. Defaulting to RUNNING here causes a race condition where the
        // "already running" check in executeAgent fails because this event handler
        // runs synchronously before the check.
        const status = StreamStatusService.get(stream);

        if (this.webviewUpdater.isAvailable()) {
          this.webviewUpdater.updateAll(
            this.state,
            StreamStatusService.getAll(),
          );
        }

        // Only update stream status if explicitly set (not for new streams)
        if (status !== undefined) {
          this.setStreamStatus(stream, status);
        }

        if (this.webviewUpdater.isAvailable()) {
          // Frontend detects stream switches using lastRenderedStream tracking.
          const activeRunId = this.refreshStreamSurface(stream, {
            updateInstruction: false,
          });
          this.sendInstructionUpdate(stream, activeRunId);
        }
      },
    );
  };

  private handleUpdateStreamStatus = (
    payload: ProgressEventPayloads['updateStreamStatus'],
  ): void => {
    withEventErrorHandling(
      'StreamStatus',
      'failed to handle updateStreamStatus',
      () =>
        this.setStreamStatus(
          payload.stream,
          payload.status,
          payload.previousStatus,
        ),
    );
  };

  private handleSetTaskState = (
    data: ProgressEventPayloads['setTaskState'],
  ): void => {
    withEventErrorHandling(
      'StreamStatus',
      'failed to handle setTaskState',
      () => {
        const { streamTabId, executionId, taskState } = data;

        this.state.setTaskState(streamTabId, taskState);
        const sessionKind = taskState.agentConfig.session.agentCategory;

        if (this.state.activeStream === streamTabId) {
          this.maybeUpdateFilterForCategory(sessionKind);
        }

        if (executionId) {
          this.state.setExecutionId(streamTabId, executionId);
        }

        if (this.state.activeStream === streamTabId) {
          this.sendInstructionUpdate(streamTabId);
        }

        if (this.webviewUpdater.isAvailable()) {
          const infos = buildStreamInfos(
            this.state,
            StreamStatusService.getAll(),
            this.state.agentTypeFilter,
          );
          this.webviewUpdater.updateStreams(
            infos,
            this.state.activeStream,
            this.state.agentTypeFilter,
          );
        }
      },
    );
  };

  private handleAddTaskGroup = (
    data: ProgressEventPayloads['addTaskGroup'],
  ): void => {
    withEventErrorHandling(
      'TaskGroup',
      'failed to handle addTaskGroup',
      async () => {
        const { stream, ...group } = data;
        const { id, parentGroupId } = group;

        const hasStream = this.state.streamTabs.has(stream);
        const addGroupPromise = this.state.taskGroups.addGroup(
          stream,
          id,
          group,
        );

        if (!parentGroupId) {
          this.state.setActiveRunId(stream, id);
        }

        if (!hasStream) {
          await this.initializeStreamForTaskGroup(stream);
        }

        // Send to webview if available and stream is active, otherwise buffer.
        // IMPORTANT: Always buffer when webview unavailable to prevent groups
        // from being dropped during initialization (e.g., Init stage).
        if (
          this.webviewUpdater.isAvailable() &&
          stream === this.state.activeStream
        ) {
          this.webviewUpdater.addTaskGroup(stream, group);
        } else {
          this.bufferTaskGroupForReplay(stream, group);
        }

        await addGroupPromise;
      },
    );
  };

  private handleUpdateTaskGroup = (
    data: ProgressEventPayloads['updateTaskGroup'],
  ): void => {
    withEventErrorHandling(
      'TaskGroup',
      'failed to handle updateTaskGroup',
      async () => {
        await this.state.taskGroups.updateGroup(data);

        if (canUpdateWebview(this.ctx, data.stream)) {
          this.webviewUpdater.updateTaskGroup(data);
        }
      },
    );
  };

  private markAllRunningTasksAsCancelled = (): void => {
    for (const [stream, status] of StreamStatusService.entries()) {
      if (status === STREAM_STATUS.RUNNING) {
        StreamStatusService.set(stream, STREAM_STATUS.STOPPED, { emit: false });
      }
    }
  };

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Send instruction updates for the provided stream
   */
  private sendInstructionUpdate(
    stream: StreamTabId | '',
    runIdHint?: StorageKey | null,
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
      // runId is already StorageKey from resolveRunId() - no normalization needed
      void this.state.runInstructions.setInstruction(
        stream,
        runId,
        instructionUpdate,
      );
    } else if (runId) {
      void this.state.runInstructions.deleteRun(stream, runId);
    }

    this.webviewUpdater.updateInstruction(
      stream,
      instructionUpdate ?? null,
      sessionKind,
    );
  }

  /**
   * Refresh all webview surface data for a specific stream.
   *
   * Sends UPDATE_LOGS with action: 'render' (or 'clear' if stream is empty).
   * Frontend detects stream switches using its lastRenderedStream tracking
   * and decides whether to do full rebuild or incremental update.
   *
   * @param options.updateInstruction - If true (default), also update instruction panel.
   * @returns The resolved active run ID, useful for callers that need to pass it
   *   to sendInstructionUpdate separately (when updateInstruction is false).
   */
  public refreshStreamSurface(
    stream: string,
    options: { updateInstruction?: boolean } = {},
  ): StorageKey | null {
    if (!this.webviewUpdater.isAvailable()) return null;

    const { updateInstruction = true } = options;

    if (!stream) {
      // No active stream: explicitly clear content with action: 'clear'.
      // This is an intentional clear (e.g., stream deleted, no streams left).
      this.webviewUpdater.updateLogContent('', [], [], undefined, 'clear');
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
    const groups = [...this.state.taskGroups.getStreamGroups(stream).values()];
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

    // Clear pending task groups buffer BEFORE update to prevent race condition.
    // If new groups arrive during updateLogContent, they'll be buffered fresh.
    // Groups already in state will be sent via updateLogContent.
    this.pendingTaskGroups.delete(stream);

    // Get context state for this stream (ephemeral - not persisted)
    const contextState = this.state.getContextState(stream);

    // Send data with action: 'render' (default).
    // Frontend detects stream switch by comparing stream with lastRenderedStream.
    this.webviewUpdater.updateLogContent(stream, messages, groups, {
      runInstructions,
      activeRunId,
      runUsage: usageByRun,
      runFiles: filesByRun,
      contextState,
    });

    // Note: Files are already included in UPDATE_LOGS (runFiles) and handled
    // by handleUpdateLogs in the frontend. We don't send separate UPDATE_FILES
    // messages here to avoid a race condition where reset: true would clear
    // the files just populated from UPDATE_LOGS.

    // Reset and send all missing outputs in sequence
    this.webviewUpdater.updateMissingOutputs(stream, { reset: true });
    for (const [runId, rounds] of Object.entries(missingByRun)) {
      this.webviewUpdater.updateMissingOutputs(stream, { runId, rounds });
    }

    // Refresh todos for the stream (ephemeral state)
    // Always send update (empty array if undefined) to clear stale UI from previous stream
    const todos = this.state.getTodos(stream) ?? [];
    this.webviewUpdater.updateTodos(stream, todos);

    // Context state is already included in updateLogContent above (via contextState field)
    // No separate UPDATE_CONTEXT_STATE message needed here

    // Update status for current stream. Don't default to RUNNING - that causes a race
    // condition where the "already running" check in executeAgent fails. Let setupFlowUIState
    // be the only place that sets RUNNING. Use READY as fallback for uninitialized streams.
    const status = StreamStatusService.get(stream) ?? STREAM_STATUS.READY;
    this.webviewUpdater.updateStatus(status);

    if (updateInstruction) {
      this.sendInstructionUpdate(stream, activeRunId);
    }

    return activeRunId;
  }

  /**
   * Get current stream status.
   * Delegates to StreamStatusService as the single source of truth.
   */
  getStreamStatus(stream: string): StreamStatus | undefined {
    return StreamStatusService.get(stream);
  }

  /**
   * Set the status for a specific stream synchronously.
   * Updates StreamStatusService (single source of truth) and triggers webview updates.
   * Note: StreamStatusService.set() already emits the event, so this method is for
   * webview update logic only - called from handleUpdateStreamStatus event handler.
   *
   * @param stream - Stream identifier
   * @param status - New status to set
   * @param previousStatus - Previous status from event payload (avoids race condition)
   */
  setStreamStatus(
    stream: string,
    status: StreamStatus,
    previousStatus?: StreamStatus,
  ): void {
    // Use previousStatus from event payload (avoids race condition) or read from service
    // for direct calls. Treat both undefined and READY as "no meaningful previous status".
    const prevStatus = previousStatus ?? StreamStatusService.get(stream);
    const hadPreviousStatus =
      prevStatus !== undefined && prevStatus !== STREAM_STATUS.READY;

    // Only update service for direct calls - event-triggered calls already mutated the service
    // before emitting (previousStatus is defined when coming from event payload)
    if (previousStatus === undefined) {
      StreamStatusService.set(stream, status, { emit: false });
    }

    if (this.webviewUpdater.isAvailable()) {
      const streamExists = this.state.streamTabs.has(stream);

      // Determine if full refresh is needed:
      // - New stream (not in tabs yet) always needs full refresh
      // - When time-sorted, only refresh if status change might affect order
      const needsFullRefresh =
        !streamExists ||
        (this.state.streamSortOrder === 'time' &&
          this.mightAffectTabOrder(
            hadPreviousStatus ? prevStatus : undefined,
            status,
          ));

      if (needsFullRefresh) {
        // Ensure filter matches the stream's category to prevent it from being filtered out.
        // This is important when resuming from WAITING state - the stream must remain visible.
        const streamCategory = this.getStreamCategory(stream);
        if (streamCategory) {
          this.maybeUpdateFilterForCategory(streamCategory);
        }

        // Include current status in refresh map so frontend displays it correctly.
        const statusesForRefresh = StreamStatusService.getAll();
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
   * Get the session category for a stream from taskState or hints.
   * Returns undefined if category cannot be determined.
   */
  private getStreamCategory(stream: string): AgentCategory | undefined {
    return (
      this.state.getTaskState(stream)?.agentConfig?.session?.agentCategory ??
      this.state.getStreamHints(stream).sessionCategory
    );
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
   * Get a copy of all stream statuses.
   * Delegates to StreamStatusService as the single source of truth.
   */
  getAllStreamStatuses(): Map<string, StreamStatus> {
    return StreamStatusService.getAll();
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
   * Groups are only deleted after successful replay to preserve them if webview unavailable.
   */
  private replayPendingTaskGroups(stream: string): void {
    const pending = this.pendingTaskGroups.get(stream);
    if (!pending || pending.length === 0) {
      return;
    }

    if (this.webviewUpdater.isAvailable()) {
      for (const group of pending) {
        this.webviewUpdater.addTaskGroup(stream, group);
      }
      this.pendingTaskGroups.delete(stream);
    }
  }

  /**
   * Initialize a stream when task group events arrive before dedicated
   * status or activation events, preserving any existing status metadata.
   */
  private async initializeStreamForTaskGroup(stream: string): Promise<void> {
    const existingStatus = StreamStatusService.get(stream);

    await this.state.streamTabs.ensureStream(stream);

    // Set status directly without triggering webview update - we do a single
    // coordinated updateAll below to avoid multiple redundant updates.
    if (existingStatus === undefined) {
      StreamStatusService.set(stream, STREAM_STATUS.RUNNING, { emit: false });
    }

    this.state.updateStreamHints(stream, {
      sessionCategory: AgentCategory.Workflow,
    });
    this.maybeUpdateFilterForCategory(AgentCategory.Workflow);
    this.state.activeStream = stream;

    if (this.webviewUpdater.isAvailable()) {
      // Single coordinated update - send UPDATE_STREAMS first so frontend
      // sets state.activeStream. Without this, UPDATE_LOGS fails _isActiveStream check.
      this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());

      // The new task group must be added to state BEFORE this call (in TaskGroupEvents)
      // so UPDATE_LOGS includes it and the frontend renders it correctly.
      // Frontend detects stream switches using lastRenderedStream tracking.
      const activeRunId = this.refreshStreamSurface(stream, {
        updateInstruction: false,
      });
      this.sendInstructionUpdate(stream, activeRunId);
    }
  }

  /**
   * Clear pending task groups for a specific stream.
   * Called when a stream is deleted to prevent memory leaks.
   */
  clearPendingTaskGroups(stream: string): void {
    this.pendingTaskGroups.delete(stream);
  }

  /**
   * Clear all pending task groups.
   * Called when all streams are deleted to prevent memory leaks.
   */
  clearAllPendingTaskGroups(): void {
    this.pendingTaskGroups.clear();
  }

  /**
   * Reset running tasks to ERROR status (used during webview reload)
   * Returns the list of affected streams for further processing
   */
  resetRunningTasksToError(waitingStreams?: Set<string>): string[] {
    const affectedStreams: string[] = [];
    const waitingSet = waitingStreams ?? new Set<string>();

    for (const [stream, status] of StreamStatusService.entries()) {
      if (status === STREAM_STATUS.RUNNING) {
        if (waitingSet.has(stream)) {
          StreamStatusService.set(stream, STREAM_STATUS.WAITING, {
            emit: false,
          });
          this.logger.debug(
            `Stream ${stream} restored to WAITING after reload`,
          );
        } else {
          StreamStatusService.set(stream, STREAM_STATUS.ERROR, { emit: false });
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
