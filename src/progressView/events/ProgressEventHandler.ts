// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent and usage types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';

// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { normalizeRunId } from '@common/constants/runIds';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { WebviewUpdater } from '@progressView/managers';
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { nestedMapToRecord } from '@progressView/persistence/serializationUtils';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports
import type {
  StreamStatus,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
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
  private _streamStatus: Map<string, StreamStatus> = new Map();
  /**
   * Buffer for task groups that arrive before their stream is activated.
   * Key: stream ID, Value: array of groups waiting to be sent to frontend.
   * Groups are replayed when setActiveStream is processed for the stream.
   */
  private readonly pendingTaskGroups = new Map<string, TaskGroup[]>();

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
    private readonly uiCallbacks: UICallbacks,
  ) {
    this.logger = new AgentLogger('ProgressEventHandler');
  }

  /**
   * Setup all event bus listeners.
   * Uses AbortController for cleanup - single dispose aborts all listeners.
   */
  setupEventListeners(): vscode.Disposable[] {
    const controller = new AbortController();
    const { signal } = controller;

    // Core stream/task events
    bus.on('setActiveStream', this.handleSetActiveStream, { signal });
    bus.on('updateStreamStatus', this.handleUpdateStreamStatus, { signal });
    bus.on('setTaskState', this.handleSetTaskState, { signal });
    bus.on('addTaskGroup', this.handleAddTaskGroup, { signal });
    bus.on('updateTaskGroup', this.handleUpdateTaskGroup, { signal });
    bus.on('extensionDeactivating', this.markAllRunningTasksAsCancelled, {
      signal,
    });

    // Log events (inlined from LogEvents.ts)
    bus.on('addLogMessage', this.handleAddLogMessage, { signal });
    bus.on('updateLogMessage', this.handleUpdateLogMessage, { signal });

    // Output events (inlined from OutputEvents.ts)
    bus.on('addOutputFiles', this.handleAddOutputFiles, { signal });
    bus.on('updateMissingOutputs', this.handleUpdateMissingOutputs, { signal });
    bus.on('clearMissingOutputs', this.handleClearMissingOutputs, { signal });

    // Usage events (inlined from UsageEvents.ts)
    bus.on('updateStreamUsage', this.handleUpdateStreamUsage, { signal });

    // Todo events (inlined from TodoEvents.ts)
    bus.on('updateTodos', this.handleUpdateTodos, { signal });

    // UI callback events (consolidated from RetryEvents + ApprovalEvents)
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

        const isStreamSwitch = this.state.activeStream !== stream;

        await this.state.streamTabs.ensureStream(stream);
        this.state.updateStreamHints(stream, {
          sessionCategory: session?.agentCategory,
          isRemote,
          hasMultipleOutputs,
        });

        if (
          session?.agentCategory &&
          this.state.agentTypeFilter !== 'all' &&
          this.state.agentTypeFilter !== session.agentCategory
        ) {
          this.state.agentTypeFilter = session.agentCategory;
        }

        this.state.activeStream = stream;
        this.replayPendingTaskGroups(stream);

        const status =
          this._streamStatus.get(stream) ?? STREAM_STATUS.RUNNING;

        if (this.webviewUpdater.isAvailable()) {
          this.webviewUpdater.updateAll(this.state, this._streamStatus);
        }

        this.setStreamStatus(stream, status);

        if (this.webviewUpdater.isAvailable()) {
          const activeRunId = this.refreshStreamSurface(stream, {
            updateInstruction: false,
            forceRebuild: isStreamSwitch,
          });
          this.sendInstructionUpdate(stream, activeRunId);
        }
      },
    );
  };

  private handleUpdateStreamStatus = (
    payload: ProgressEventPayloads['updateStreamStatus'],
  ): void => {
    withEventErrorHandling('StreamStatus', 'failed to handle updateStreamStatus', () =>
      this.setStreamStatus(payload.stream, payload.status),
    );
  };

  private handleSetTaskState = (
    data: ProgressEventPayloads['setTaskState'],
  ): void => {
    withEventErrorHandling('StreamStatus', 'failed to handle setTaskState', () => {
      const { streamTabId, executionId, taskState } = data;

      this.state.setTaskState(streamTabId, taskState);
      const sessionKind = taskState.agentConfig.session.agentCategory;

      if (
        this.state.activeStream === streamTabId &&
        this.state.agentTypeFilter !== 'all' &&
        this.state.agentTypeFilter !== sessionKind
      ) {
        this.state.agentTypeFilter = sessionKind;
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
          this._streamStatus,
          this.state.agentTypeFilter,
        );
        this.webviewUpdater.updateStreams(
          infos,
          this.state.activeStream,
          this.state.agentTypeFilter,
        );
      }
    });
  };

  private handleAddTaskGroup = (
    data: ProgressEventPayloads['addTaskGroup'],
  ): void => {
    withEventErrorHandling('TaskGroup', 'failed to handle addTaskGroup', async () => {
      const { stream, ...group } = data;
      const { id, parentGroupId } = group;

      const hasStream = this.state.streamTabs.has(stream);
      const addGroupPromise = this.state.taskGroups.addGroup(stream, id, group);

      if (!parentGroupId) {
        this.state.setActiveRunId(stream, id);
      }

      if (!hasStream) {
        await this.initializeStreamForTaskGroup(stream);
      }

      if (this.webviewUpdater.isAvailable()) {
        if (stream === this.state.activeStream) {
          this.webviewUpdater.addTaskGroup(stream, group);
        } else {
          this.bufferTaskGroupForReplay(stream, group);
        }
      }

      await addGroupPromise;
    });
  };

  private handleUpdateTaskGroup = (
    data: ProgressEventPayloads['updateTaskGroup'],
  ): void => {
    withEventErrorHandling('TaskGroup', 'failed to handle updateTaskGroup', async () => {
      await this.state.taskGroups.updateGroup(data);

      if (
        this.webviewUpdater.isAvailable() &&
        data.stream === this.state.activeStream
      ) {
        this.webviewUpdater.updateTaskGroup(data);
      }
    });
  };

  private markAllRunningTasksAsCancelled = (): void => {
    for (const [stream, status] of this._streamStatus.entries()) {
      if (status === STREAM_STATUS.RUNNING) {
        this._streamStatus.set(stream, STREAM_STATUS.STOPPED);
      }
    }
  };

  // ============================================================================
  // Inlined Event Handlers (formerly separate modules)
  // ============================================================================

  /** Handle addLogMessage - inlined from LogEvents.ts */
  private handleAddLogMessage = ({
    stream,
    logMessage,
  }: ProgressEventPayloads['addLogMessage']): void => {
    withEventErrorHandling('LogEvents', 'failed to handle addLogMessage', async () => {
      const isNew = await this.state.streamTabs.addMessage(stream, logMessage);
      if (isNew && this.webviewUpdater.isAvailable()) {
        this.webviewUpdater.appendLogMessage(stream, logMessage);
      }
    });
  };

  /** Handle updateLogMessage - inlined from LogEvents.ts */
  private handleUpdateLogMessage = ({
    stream,
    logMessage,
  }: ProgressEventPayloads['updateLogMessage']): void => {
    withEventErrorHandling('LogEvents', 'failed to handle updateLogMessage', async () => {
      if (!this.state.streamTabs.has(stream)) return;

      const messages = this.state.streamTabs.getMessages(stream);
      const existing = messages.find((m) => m.id === logMessage.id);
      if (!existing) return;

      // Skip INTERNAL message updates
      if (
        existing.messageType === MESSAGE_TYPES.INTERNAL ||
        logMessage.messageType === MESSAGE_TYPES.INTERNAL
      ) {
        return;
      }

      // Update fields if provided
      if (logMessage.text !== undefined) existing.text = logMessage.text;
      if (logMessage.messageType !== undefined)
        existing.messageType = logMessage.messageType;
      if (logMessage.level) existing.level = logMessage.level;
      if (logMessage.timestamp !== undefined)
        existing.timestamp = logMessage.timestamp;
      if (logMessage.verbose !== undefined) existing.verbose = logMessage.verbose;
      if (logMessage.data !== undefined) existing.data = logMessage.data;

      await this.state.streamTabs.save();

      if (
        this.webviewUpdater.isAvailable() &&
        stream === this.state.activeStream
      ) {
        this.webviewUpdater.updateLogMessage(stream, existing);
      }
    });
  };

  /** Handle addOutputFiles - inlined from OutputEvents.ts */
  private handleAddOutputFiles = ({
    stream,
    storageKey,
    filesByRound,
  }: ProgressEventPayloads['addOutputFiles']): void => {
    withEventErrorHandling('OutputEvents', 'failed to handle addOutputFiles', async () => {
      await this.state.outputFiles.addFiles(stream, storageKey, filesByRound);
      if (!this.webviewUpdater.isAvailable()) return;

      const runFiles = this.state.outputFiles.getFiles(stream).get(storageKey);
      const rounds = this.toRoundRecord(runFiles);
      this.webviewUpdater.updateFiles(
        stream,
        rounds ? { runId: storageKey, rounds } : { runId: storageKey },
      );
    });
  };

  /** Handle updateMissingOutputs - inlined from OutputEvents.ts */
  private handleUpdateMissingOutputs = ({
    stream,
    storageKey,
    filesByRound,
  }: ProgressEventPayloads['updateMissingOutputs']): void => {
    withEventErrorHandling(
      'OutputEvents',
      'failed to handle updateMissingOutputs',
      async () => {
        await this.state.outputFiles.updateMissingOutputs(
          stream,
          storageKey,
          filesByRound,
        );
        if (!this.webviewUpdater.isAvailable()) return;

        const runMissing = this.state.outputFiles
          .getMissingOutputs(stream)
          .get(storageKey);
        const rounds = this.toRoundRecord(runMissing);
        this.webviewUpdater.updateMissingOutputs(
          stream,
          rounds ? { runId: storageKey, rounds } : { runId: storageKey },
        );
      },
    );
  };

  /** Handle clearMissingOutputs - inlined from OutputEvents.ts */
  private handleClearMissingOutputs = ({
    stream,
  }: ProgressEventPayloads['clearMissingOutputs']): void => {
    withEventErrorHandling(
      'OutputEvents',
      'failed to handle clearMissingOutputs',
      async () => {
        await this.state.outputFiles.clearMissingOutputs(stream);
        if (
          this.webviewUpdater.isAvailable() &&
          stream === this.state.activeStream
        ) {
          this.webviewUpdater.updateMissingOutputs(stream, { reset: true });
        }
      },
    );
  };

  /** Handle updateStreamUsage - inlined from UsageEvents.ts */
  private handleUpdateStreamUsage = ({
    stream,
    usage,
    storageKey,
  }: ProgressEventPayloads['updateStreamUsage']): void => {
    withEventErrorHandling('UsageEvents', 'failed to handle updateStreamUsage', async () => {
      const normalizedUsage: TokenUsageStats = {
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        cost: Number(usage.cost ?? 0),
      };

      await this.state.usageStats.setRunUsage(stream, storageKey, normalizedUsage);

      if (
        this.webviewUpdater.isAvailable() &&
        stream === this.state.activeStream
      ) {
        this.webviewUpdater.updateRunUsage(stream, storageKey, normalizedUsage);
      }
    });
  };

  /** Handle updateTodos - inlined from TodoEvents.ts */
  private handleUpdateTodos = ({
    stream,
    todos,
  }: ProgressEventPayloads['updateTodos']): void => {
    withEventErrorHandling('TodoEvents', 'failed to handle updateTodos', () => {
      this.state.setTodos(stream, todos);
      if (
        this.webviewUpdater.isAvailable() &&
        stream === this.state.activeStream
      ) {
        this.webviewUpdater.updateTodos(stream, todos);
      }
    });
  };

  /** Convert Map<number, T[]> to Record<number, T[]> for webview (from OutputEvents.ts) */
  private toRoundRecord<T>(
    rounds?: Map<number, T[]>,
  ): Record<number, T[]> | undefined {
    return rounds && rounds.size > 0
      ? Object.fromEntries(rounds.entries())
      : undefined;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

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
