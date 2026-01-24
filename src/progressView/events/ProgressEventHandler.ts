// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { OutputFileInfo } from '@agent/output/types';
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
import {
  ProgressViewState,
  type ActiveStreamId,
} from '@progressView/state/ProgressViewState';
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
  private readonly pendingTaskGroups = new Map<StreamTabId, TaskGroup[]>();

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
   * Update agentCategoryFilter to match the session category if needed.
   * Only updates when filter is not 'all' and doesn't already match.
   */
  private maybeUpdateFilterForCategory(
    category: AgentCategory | undefined,
  ): void {
    if (
      category &&
      this.state.agentCategoryFilter !== 'all' &&
      this.state.agentCategoryFilter !== category
    ) {
      this.state.agentCategoryFilter = category;
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
    const { streamId, agentCategory, isRemote, hasMultipleOutputs } = payload;
    if (!streamId) return;

    await this.state.streamTabs.ensureStream(streamId);
    this.state.updateStreamHints(streamId, {
      agentCategory,
      isRemote,
      hasMultipleOutputs,
    });
    this.maybeUpdateFilterForCategory(agentCategory);
    this.state.activeStream = streamId;
    this.replayPendingTaskGroups(streamId);

    if (!this.webviewUpdater.isAvailable()) return;

    // Update stream tabs list (required to set activeStream in frontend)
    this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());

    // Refresh stream content: status first (critical), then logs, then todos/instruction
    this.refreshStreamSurface(streamId, { updateInstruction: true });
  }

  private handleUpdateStreamStatus = (
    payload: ProgressEventPayloads['updateStreamStatus'],
  ): void => {
    withEventErrorHandling(
      'StreamStatus',
      'failed to handle updateStreamStatus',
      () =>
        this.setStreamStatus(
          payload.streamId,
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
        const { streamId, executionId, taskState } = data;
        const isActiveStream = this.state.activeStream === streamId;
        const category = taskState.agentConfig.agentCategory;
        const previousFilter = this.state.agentCategoryFilter;

        this.state.setTaskState(streamId, taskState);

        if (isActiveStream) {
          this.maybeUpdateFilterForCategory(category);
        }

        if (executionId) {
          this.state.setExecutionId(streamId, executionId);
        }

        if (isActiveStream) {
          this.sendInstructionUpdate(streamId);
        }

        // Update stream tabs when filter changes or active stream gets metadata.
        // Filter change affects visible streams; active stream update ensures
        // tab label reflects latest taskState (agent name, input file, etc.).
        if (this.webviewUpdater.isAvailable()) {
          const filterChanged =
            this.state.agentCategoryFilter !== previousFilter;
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
        const { streamId, ...group } = data;
        const { id, parentGroupId } = group;

        const hasStream = this.state.streamTabs.has(streamId);
        const addGroupPromise = this.state.taskGroups.addGroup(
          streamId,
          id,
          group,
        );

        if (!parentGroupId) {
          this.state.setActiveRunId(streamId, id);
        }

        if (!hasStream) {
          await this.initializeStreamForTaskGroup(streamId);
        }

        // Send to webview if available and stream is active, otherwise buffer.
        // IMPORTANT: Always buffer when webview unavailable to prevent groups
        // from being dropped during initialization (e.g., Init stage).
        if (
          this.webviewUpdater.isAvailable() &&
          streamId === this.state.activeStream
        ) {
          this.webviewUpdater.addTaskGroup(streamId, group);
        } else {
          this.bufferTaskGroupForReplay(streamId, group);
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

        if (canUpdateWebview(this.ctx, data.streamId)) {
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
    const category = this.getStreamCategory(stream);

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
      category,
    );
  }

  /**
   * Refresh all webview surface data for a specific stream.
   *
   * Sends UPDATE_LOGS with action: 'render' (or 'clear' if stream is empty).
   * Frontend detects stream switches using its lastRenderedStream tracking
   * and decides whether to do full rebuild or incremental update.
   *
   * NOTE: Status/todos/instruction are sent as separate small messages rather
   * than batched into UPDATE_LOGS. This ensures critical UI feedback (status)
   * isn't blocked by potentially large log payloads, and provides fault isolation
   * if the large payload has issues.
   *
   * Performance: Only serializes the active run's files/missing outputs by default.
   * Other runs' data is loaded on-demand when the user switches runs.
   *
   * @param stream - Stream to refresh, or empty string to clear all content.
   * @param options.updateInstruction - If true (default), also update instruction panel.
   * @returns The resolved active run ID, useful for callers that need to pass it
   *   to sendInstructionUpdate separately (when updateInstruction is false).
   */
  public refreshStreamSurface(
    stream: ActiveStreamId,
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

    // Serialize only instructions (small) and active run's files/outputs (needed for display)
    // Other runs' data is kept in state and sent on-demand when user switches runs
    const runInstructions = Object.fromEntries(
      this.state.getRunInstructions(stream).entries(),
    );

    // Only serialize active run's files and missing outputs (performance optimization)
    // This reduces serialization overhead from O(runs * rounds * files) to O(rounds * files)
    let runFiles: Record<string, { [key: number]: OutputFileInfo[] }> = {};
    let runMissingOutputs: Record<string, { [key: number]: string[] }> = {};

    if (activeRunId) {
      const activeFiles = this.state.outputFiles.getRunFiles(stream, activeRunId);
      if (activeFiles && activeFiles.size > 0) {
        runFiles = {
          [activeRunId]: Object.fromEntries(
            Array.from(activeFiles, ([k, v]) => [String(k), v]),
          ),
        };
      }

      const activeMissing = this.state.outputFiles.getRunMissingOutputs(
        stream,
        activeRunId,
      );
      if (activeMissing && activeMissing.size > 0) {
        runMissingOutputs = {
          [activeRunId]: Object.fromEntries(
            Array.from(activeMissing, ([k, v]) => [String(k), v]),
          ),
        };
      }
    }

    // Usage stats are small, serialize all runs (needed for aggregate display)
    const runUsage = Object.fromEntries(
      this.state.usageStats.getRunUsage(stream).entries(),
    ) as Record<string, TokenUsageStats>;

    const contextState = this.state.getContextState(stream);
    const todos = this.state.getTodos(stream) ?? [];

    // Clear pendingTaskGroups since we're doing a full refresh from state.taskGroups.
    // This handles both: (1) processSetActiveStream flow (replayPendingTaskGroups called first),
    // (2) updateWebview flow (called directly without replay, groups already in state).
    this.pendingTaskGroups.delete(stream);

    // NOTE: Status already sent via updateAll() → UPDATE_STREAMS → handleUpdateStreams.

    // Send primary content update (includes active run's data)
    this.webviewUpdater.updateLogContent(stream, messages, groups, {
      runInstructions,
      activeRunId,
      runUsage,
      runFiles,
      runMissingOutputs,
      contextState,
    });

    // Send ephemeral state separately (small, independent messages)
    this.webviewUpdater.updateTodos(stream, todos);

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
  getStreamStatus(streamId: StreamTabId): StreamStatus | undefined {
    return StreamStatusService.get(streamId);
  }

  /**
   * Set the status for a specific stream synchronously.
   * Updates StreamStatusService (single source of truth) and triggers webview updates.
   *
   * For NEW streams: full refresh (adds stream to tab list)
   * For EXISTING streams: targeted status update only (no rebuild)
   *
   * Tab reordering is driven by log timestamps, not status changes.
   * Status is just a visual indicator - no need to rebuild tabs for it.
   */
  setStreamStatus(
    streamId: StreamTabId,
    status: StreamStatus,
    previousStatus?: StreamStatus,
  ): void {
    const isDirectCall = previousStatus === undefined;
    if (isDirectCall) {
      StreamStatusService.set(streamId, status, { emit: false });
    }

    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    const streamExists = this.state.streamTabs.has(streamId);

    if (!streamExists) {
      // New stream - full refresh to add it to tab list
      const streamCategory = this.getStreamCategory(streamId);
      if (streamCategory) {
        this.maybeUpdateFilterForCategory(streamCategory);
      }
      const statusesForRefresh = StreamStatusService.getAll();
      statusesForRefresh.set(streamId, status);
      this.webviewUpdater.updateAll(this.state, statusesForRefresh);
    } else {
      // Existing stream - targeted status update only
      const lastTimestamp = this.state.streamTabs.getLastTimestamp(streamId);
      this.webviewUpdater.updateStreamStatus(streamId, status, lastTimestamp);
    }
  }

  /**
   * Get the agent category for a stream from taskState or hints.
   */
  private getStreamCategory(streamId: StreamTabId): AgentCategory | undefined {
    const taskState = this.state.getTaskState(streamId);
    return (
      taskState?.agentConfig?.agentCategory ??
      this.state.getStreamHints(streamId).agentCategory
    );
  }

  /**
   * Get a copy of all stream statuses.
   * Delegates to StreamStatusService as the single source of truth.
   */
  getAllStreamStatuses(): Map<StreamTabId, StreamStatus> {
    return StreamStatusService.getAll();
  }

  /**
   * Buffer a task group for later replay when the stream becomes active.
   * Called by TaskGroupEvents when addTaskGroup arrives before setActiveStream.
   */
  private bufferTaskGroupForReplay(
    streamId: StreamTabId,
    group: TaskGroup,
  ): void {
    const pending = this.pendingTaskGroups.get(streamId) ?? [];
    pending.push(group);
    this.pendingTaskGroups.set(streamId, pending);
  }

  /**
   * Replay any buffered task groups for a stream after it becomes active.
   * Groups are only deleted after successful replay to preserve them if webview unavailable.
   */
  private replayPendingTaskGroups(streamId: StreamTabId): void {
    const pending = this.pendingTaskGroups.get(streamId);
    if (!pending || pending.length === 0) {
      return;
    }

    if (this.webviewUpdater.isAvailable()) {
      for (const group of pending) {
        this.webviewUpdater.addTaskGroup(streamId, group);
      }
      this.pendingTaskGroups.delete(streamId);
    }
  }

  /**
   * Initialize a stream when task group events arrive before dedicated
   * status or activation events, preserving any existing status metadata.
   */
  private async initializeStreamForTaskGroup(
    streamId: StreamTabId,
  ): Promise<void> {
    await this.state.streamTabs.ensureStream(streamId);

    // Set status to RUNNING if not already set (without emitting to avoid redundant updates)
    if (!StreamStatusService.has(streamId)) {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, { emit: false });
    }

    this.state.updateStreamHints(streamId, {
      agentCategory: AgentCategory.Workflow,
    });
    this.maybeUpdateFilterForCategory(AgentCategory.Workflow);
    this.state.activeStream = streamId;

    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    // Coordinated update: UPDATE_STREAMS first (sets frontend activeStream),
    // then stream content (requires activeStream to be set)
    this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());
    this.refreshStreamSurface(streamId, { updateInstruction: true });
  }

  /**
   * Clear pending task groups for a specific stream.
   * Called when a stream is deleted to prevent memory leaks.
   */
  clearPendingTaskGroups(streamId: StreamTabId): void {
    this.pendingTaskGroups.delete(streamId);
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
  resetRunningTasksToError(waitingStreams?: Set<StreamTabId>): StreamTabId[] {
    const affectedStreams: StreamTabId[] = [];
    const waitingSet = waitingStreams ?? new Set<StreamTabId>();

    for (const [streamId, status] of StreamStatusService.entries()) {
      if (status !== STREAM_STATUS.RUNNING) continue;

      if (waitingSet.has(streamId)) {
        StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
          emit: false,
        });
        this.logger.debug(
          `Stream ${streamId} restored to WAITING after reload`,
        );
        continue;
      }

      StreamStatusService.set(streamId, STREAM_STATUS.ERROR, {
        emit: false,
      });
      affectedStreams.push(streamId);
      this.logger.debug(
        `Stream ${streamId} set to ERROR due to webview reload`,
      );
    }

    return affectedStreams;
  }
}
