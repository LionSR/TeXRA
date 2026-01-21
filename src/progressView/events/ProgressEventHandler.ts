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
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { nestedMapToRecord } from '@progressView/persistence/serializationUtils';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports - domain event handlers
import {
  canUpdateWebview,
  type EventHandlerContext,
} from './EventHandlerContext';
import { registerLogEventHandlers } from './LogEventHandlers';
import { registerOutputEventHandlers } from './OutputEventHandlers';
import { registerUsageEventHandlers } from './UsageEventHandlers';
import { registerTodoEventHandlers } from './TodoEventHandlers';
import { registerFollowUpEventHandlers } from './FollowUpEventHandlers';
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
   * - Follow-up events: FollowUpEventHandlers.ts
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
    registerFollowUpEventHandlers(bus, this.ctx, signal);
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
      () => this.processSetActiveStream(payload),
    );
  };

  /** Core logic for setActiveStream event, separated for clarity */
  private async processSetActiveStream(
    payload: ProgressEventPayloads['setActiveStream'],
  ): Promise<void> {
    const { stream, agentCategory, isRemote, hasMultipleOutputs } = payload;
    if (!stream) return;

    await this.state.streamTabs.ensureStream(stream);
    this.state.updateStreamHints(stream, {
      agentCategory,
      isRemote,
      hasMultipleOutputs,
    });
    this.maybeUpdateFilterForCategory(agentCategory);
    this.state.activeStream = stream;
    this.replayPendingTaskGroups(stream);

    if (!this.webviewUpdater.isAvailable()) return;

    // Update stream tabs list (required to set activeStream in frontend)
    this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());

    // Refresh stream content (logs, groups, metadata, status, todos)
    // Note: refreshStreamSurface includes status update, so no separate setStreamStatus needed
    const activeRunId = this.refreshStreamSurface(stream, {
      updateInstruction: false,
    });
    this.sendInstructionUpdate(stream, activeRunId);
  }

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
        const isActiveStream = this.state.activeStream === streamTabId;
        const sessionKind = taskState.agentConfig.agentCategory;
        const previousFilter = this.state.agentTypeFilter;

        this.state.setTaskState(streamTabId, taskState);

        if (isActiveStream) {
          this.maybeUpdateFilterForCategory(sessionKind);
        }

        if (executionId) {
          this.state.setExecutionId(streamTabId, executionId);
        }

        if (isActiveStream) {
          this.sendInstructionUpdate(streamTabId);
        }

        // Update stream tabs when:
        // 1. Filter changed (affects visible streams)
        // 2. Active stream's task state changed (label needs inputFile, agent, etc.)
        if (this.webviewUpdater.isAvailable()) {
          const filterChanged = this.state.agentTypeFilter !== previousFilter;
          if (filterChanged || isActiveStream) {
            this.webviewUpdater.updateAll(
              this.state,
              StreamStatusService.getAll(),
            );
          }
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
   * Send instruction updates for the provided stream.
   * @param runIdHint - Use undefined to auto-resolve, null to skip persistence
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
    const sessionKind = this.getStreamCategory(stream);

    // Use provided runId or read cached activeRunId (no expensive resolution)
    const runId =
      runIdHint === undefined ? this.state.getActiveRunId(stream) : runIdHint;

    // Persist instruction if both runId and instruction exist
    if (runId) {
      if (instructionUpdate) {
        void this.state.setRunInstruction(stream, runId, instructionUpdate);
      } else {
        void this.state.deleteRunInstruction(stream, runId);
      }
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

    // Handle empty stream (clear all content)
    if (!stream) {
      this.clearStreamSurface(updateInstruction);
      return null;
    }

    // Collect stream data (activeRunId is already set by event handlers when data arrives)
    const messages = this.state.streamTabs.getMessages(stream);
    const groups = [...this.state.taskGroups.getStreamGroups(stream).values()];
    const activeRunId = this.state.getActiveRunId(stream);

    const runInstructions = Object.fromEntries(
      this.state.getRunInstructions(stream).entries(),
    );
    const runFiles = nestedMapToRecord(this.state.outputFiles.getFiles(stream));
    const runMissingOutputs = nestedMapToRecord(
      this.state.outputFiles.getMissingOutputs(stream),
    ) as Record<string, { [key: number]: string[] }>;
    const runUsage = Object.fromEntries(
      this.state.usageStats.getRunUsage(stream).entries(),
    ) as Record<string, TokenUsageStats>;
    const contextState = this.state.getContextState(stream);
    const todos = this.state.getTodos(stream) ?? [];
    const status = StreamStatusService.get(stream) ?? STREAM_STATUS.READY;

    // Clear buffer before update to prevent race condition
    this.pendingTaskGroups.delete(stream);

    // Send primary content update (includes all run-scoped data in single message)
    this.webviewUpdater.updateLogContent(stream, messages, groups, {
      runInstructions,
      activeRunId,
      runUsage,
      runFiles,
      runMissingOutputs,
      contextState,
    });

    // Send ephemeral state
    this.webviewUpdater.updateTodos(stream, todos);
    this.webviewUpdater.updateStatus(status);

    if (updateInstruction) {
      this.sendInstructionUpdate(stream, activeRunId);
    }

    return activeRunId;
  }

  /**
   * Clear all webview content when no stream is active.
   *
   * Note: updateLogContent with action='clear' triggers the frontend to clear
   * all run-scoped state (files, missing outputs, usage). No separate reset
   * messages needed - the frontend handles this in its full rebuild path.
   */
  private clearStreamSurface(clearInstruction: boolean): void {
    this.webviewUpdater.updateLogContent('', [], [], undefined, 'clear');
    this.webviewUpdater.updateStatus(STREAM_STATUS.READY);
    if (clearInstruction) {
      this.webviewUpdater.updateInstruction('', null);
    }
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
   *
   * @param stream - Stream identifier
   * @param status - New status to set
   * @param previousStatus - Previous status from event payload (undefined for direct calls)
   */
  setStreamStatus(
    stream: string,
    status: StreamStatus,
    previousStatus?: StreamStatus,
  ): void {
    // For direct calls (no previousStatus), update service without emitting.
    // Event-triggered calls already mutated the service before emitting.
    const isDirectCall = previousStatus === undefined;
    if (isDirectCall) {
      StreamStatusService.set(stream, status, { emit: false });
    }

    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    // Resolve previous status: from event payload or read current (for direct calls).
    // Treat READY as "no previous status" for ordering purposes.
    const prevStatus = previousStatus ?? StreamStatusService.get(stream);
    const effectivePrevious =
      prevStatus === STREAM_STATUS.READY ? undefined : prevStatus;

    const streamExists = this.state.streamTabs.has(stream);
    const needsFullRefresh =
      !streamExists ||
      (this.state.streamSortOrder === 'time' &&
        StreamStatusService.mightAffectTabOrder(effectivePrevious, status));

    if (needsFullRefresh) {
      // Ensure filter matches stream's category to keep it visible (e.g., when resuming)
      const streamCategory = this.getStreamCategory(stream);
      if (streamCategory) {
        this.maybeUpdateFilterForCategory(streamCategory);
      }

      const statusesForRefresh = StreamStatusService.getAll();
      statusesForRefresh.set(stream, status);
      this.webviewUpdater.updateAll(this.state, statusesForRefresh);
    } else {
      // Targeted update - send only status change for this stream
      const logs = this.state.streamTabs.getMessages(stream);
      const lastTimestamp = logs.at(-1)?.timestamp;
      this.webviewUpdater.updateStreamStatus(stream, status, lastTimestamp);
    }
  }

  /**
   * Get the agent category for a stream from taskState or hints.
   */
  private getStreamCategory(stream: string): AgentCategory | undefined {
    const taskState = this.state.getTaskState(stream);
    return (
      taskState?.agentConfig?.agentCategory ??
      this.state.getStreamHints(stream).agentCategory
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
    await this.state.streamTabs.ensureStream(stream);

    // Set status to RUNNING if not already set (without emitting to avoid redundant updates)
    if (!StreamStatusService.has(stream)) {
      StreamStatusService.set(stream, STREAM_STATUS.RUNNING, { emit: false });
    }

    this.state.updateStreamHints(stream, {
      agentCategory: AgentCategory.Workflow,
    });
    this.maybeUpdateFilterForCategory(AgentCategory.Workflow);
    this.state.activeStream = stream;

    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    // Coordinated update: UPDATE_STREAMS first (sets frontend activeStream),
    // then UPDATE_LOGS (requires activeStream to be set)
    this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());
    const activeRunId = this.refreshStreamSurface(stream, {
      updateInstruction: false,
    });
    this.sendInstructionUpdate(stream, activeRunId);
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
