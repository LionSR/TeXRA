import * as vscode from 'vscode';

import {
  STREAM_STATUS,
  type ConversationProgress,
  type StorageKey,
  type StreamStatus,
  type StreamTabId,
  type TaskGroup,
  type TokenUsageStats,
} from '@shared/schemas';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { AgentLogger } from '@logger/AgentLogger';
import { WebviewUpdater } from '@progressView/managers/WebviewUpdater';
import { nestedMapToRecord } from '@progressView/persistence/serializationUtils';
import {
  ProgressViewState,
  type ActiveStreamId,
} from '@progressView/state/ProgressViewState';
import { bus } from '@eventBus/ProgressEventBus';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { streamEventQueue } from '@eventBus/StreamEventQueue';

import { withEventErrorHandling } from './errorHandling';
import { registerFollowUpEventHandlers } from './FollowUpEventHandlers';
import { registerLogEventHandlers } from './LogEventHandlers';
import { registerOutputEventHandlers } from './OutputEventHandlers';
import { registerTodoEventHandlers } from './TodoEventHandlers';
import { registerUIEvents, type UICallbacks } from './UIEvents';
import { registerUsageEventHandlers } from './UsageEventHandlers';
import type { EventHandlerContext } from './EventHandlerContext';

export type { UICallbacks };

/** Throttle interval for conversation progress webview pushes (ms). */
const PROGRESS_THROTTLE_MS = 500;

/** Handles progress event bus subscriptions for the progress view. */
export class ProgressEventHandler {
  private readonly logger: AgentLogger;
  private readonly pendingTaskGroups = new Map<StreamTabId, TaskGroup[]>();
  private readonly ctx: EventHandlerContext;
  private progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProgressUpdates = new Map<StreamTabId, ConversationProgress>();

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
    private readonly uiCallbacks: UICallbacks,
  ) {
    this.logger = new AgentLogger('ProgressEventHandler');
    this.ctx = { state: this.state, webviewUpdater: this.webviewUpdater };
  }

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

  setupEventListeners(): vscode.Disposable[] {
    const controller = new AbortController();
    const { signal } = controller;

    bus.on('setActiveStream', this.handleSetActiveStream, { signal });
    bus.on('updateStreamStatus', this.handleUpdateStreamStatus, { signal });
    bus.on('setTaskState', this.handleSetTaskState, { signal });
    bus.on('addTaskGroup', this.handleAddTaskGroup, { signal });
    bus.on('updateTaskGroup', this.handleUpdateTaskGroup, { signal });
    bus.on(
      'updateConversationProgress',
      this.handleUpdateConversationProgress,
      { signal },
    );
    bus.on('updateActiveSubagents', this.handleUpdateActiveSubagents, {
      signal,
    });
    bus.on('updateActiveProcesses', this.handleUpdateActiveProcesses, {
      signal,
    });
    bus.on('setParentStream', this.handleSetParentStream, { signal });
    bus.on('extensionDeactivating', this.markAllRunningTasksAsCancelled, {
      signal,
    });

    registerLogEventHandlers(bus, this.ctx, signal);
    registerOutputEventHandlers(bus, this.ctx, signal);
    registerUsageEventHandlers(bus, this.ctx, signal);
    registerTodoEventHandlers(bus, this.ctx, signal);
    registerFollowUpEventHandlers(bus, this.ctx, signal);
    registerUIEvents(bus, this.uiCallbacks, signal);

    return [
      new vscode.Disposable(() => {
        controller.abort();
        if (this.progressThrottleTimer) {
          clearTimeout(this.progressThrottleTimer);
          this.progressThrottleTimer = null;
        }
        this.pendingProgressUpdates.clear();
      }),
    ];
  }

  private handleSetActiveStream = (
    payload: ProgressEventPayloads['setActiveStream'],
  ): void => {
    withEventErrorHandling(
      'StreamStatus',
      'failed to handle setActiveStream',
      () => {
        const { streamId, agentCategory, isRemote, hasMultipleOutputs } =
          payload;
        if (!streamId) return;

        this.state.streamTabs.ensureStream(streamId);
        this.state.updateStreamHints(streamId, {
          agentCategory,
          isRemote,
          hasMultipleOutputs,
        });
        // Ensure stream state exists so it's included in getAllStreamStates()
        if (agentCategory) {
          this.state.getOrCreateStreamState(streamId, agentCategory);
        }
        this.maybeUpdateFilterForCategory(agentCategory);
        this.state.activeStream = streamId;
        this.replayPendingTaskGroups(streamId);

        if (!this.webviewUpdater.isAvailable()) return;

        this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());
        this.refreshStreamSurface(streamId, { updateInstruction: true });
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
    withEventErrorHandling('TaskGroup', 'failed to handle addTaskGroup', () =>
      streamEventQueue.enqueue(data.streamId, () =>
        this.processAddTaskGroup(data),
      ),
    );
  };

  private async processAddTaskGroup(
    data: ProgressEventPayloads['addTaskGroup'],
  ): Promise<void> {
    const { streamId, ...group } = data;
    const { id, parentGroupId } = group;

    const hasStream = this.state.streamTabs.has(streamId);
    const addGroupPromise = this.state.taskGroups.addGroup(streamId, id, group);

    if (!parentGroupId) {
      this.state.setActiveRunId(streamId, id);
    }

    if (!hasStream) {
      await this.initializeStreamForTaskGroup(streamId);
    }

    if (
      this.webviewUpdater.isAvailable() &&
      streamId === this.state.activeStream
    ) {
      this.webviewUpdater.addTaskGroup(streamId, group);
    } else {
      this.bufferTaskGroupForReplay(streamId, group);
    }

    await addGroupPromise;
  }

  private handleUpdateTaskGroup = (
    data: ProgressEventPayloads['updateTaskGroup'],
  ): void => {
    withEventErrorHandling(
      'TaskGroup',
      'failed to handle updateTaskGroup',
      () =>
        streamEventQueue.enqueue(data.streamId, () =>
          this.processUpdateTaskGroup(data),
        ),
    );
  };

  private async processUpdateTaskGroup(
    data: ProgressEventPayloads['updateTaskGroup'],
  ): Promise<void> {
    const groups = this.state.taskGroups.getStreamGroups(data.streamId);
    if (!groups.has(data.id)) {
      // StreamEventQueue serializes events per stream, so addTaskGroup always
      // completes before updateTaskGroup. If we hit this, there's a bug.
      this.logger.warn(
        `updateTaskGroup for unknown group ${data.id} in stream ${data.streamId}`,
      );
      return;
    }

    await this.state.taskGroups.updateGroup(data);

    const isActive = data.streamId === this.state.activeStream;
    if (this.webviewUpdater.isAvailable() && isActive) {
      this.webviewUpdater.updateTaskGroup(data);
    }
  }

  private handleUpdateConversationProgress = (
    data: ProgressEventPayloads['updateConversationProgress'],
  ): void => {
    withEventErrorHandling(
      'ConversationProgress',
      'failed to handle updateConversationProgress',
      () => {
        const { streamId, progress } = data;

        // Always update state immediately so other updateAll calls include it
        this.state.updateStreamState(streamId, (prev) => ({
          ...prev,
          conversationProgress: progress,
        }));

        // Throttle webview pushes: buffer per-stream, flush on timer
        this.pendingProgressUpdates.set(streamId, progress);
        if (!this.progressThrottleTimer) {
          this.progressThrottleTimer = setTimeout(() => {
            this.flushProgressUpdates();
          }, PROGRESS_THROTTLE_MS);
        }
      },
    );
  };

  private flushProgressUpdates(): void {
    this.progressThrottleTimer = null;
    if (
      this.pendingProgressUpdates.size === 0 ||
      !this.webviewUpdater.isAvailable()
    ) {
      this.pendingProgressUpdates.clear();
      return;
    }

    // Only push a full update if the active stream has pending progress
    const activeStream = this.state.activeStream;
    if (activeStream && this.pendingProgressUpdates.has(activeStream)) {
      this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());
    }
    this.pendingProgressUpdates.clear();
  }

  private handleUpdateActiveSubagents = (
    data: ProgressEventPayloads['updateActiveSubagents'],
  ): void => {
    withEventErrorHandling(
      'ActiveSubagents',
      'failed to handle updateActiveSubagents',
      () => {
        const { parentStreamId, children } = data;

        // Update active list and accumulate finished count
        this.state.updateStreamState(parentStreamId, (prev) => {
          const prevIds = new Set(
            prev.activeSubagents.map((s) => s.executionId),
          );
          const nextIds = new Set(children.map((s) => s.executionId));
          const newlyFinished = [...prevIds].filter(
            (id) => !nextIds.has(id),
          ).length;
          return {
            ...prev,
            activeSubagents: children,
            finishedSubagentCount:
              (prev.finishedSubagentCount ?? 0) + newlyFinished,
          };
        });

        // Only push to webview if the orchestrator is the active stream
        if (
          this.webviewUpdater.isAvailable() &&
          parentStreamId === this.state.activeStream
        ) {
          this.webviewUpdater.updateAll(
            this.state,
            StreamStatusService.getAll(),
          );
        }
      },
    );
  };

  private handleUpdateActiveProcesses = (
    data: ProgressEventPayloads['updateActiveProcesses'],
  ): void => {
    withEventErrorHandling(
      'ActiveProcesses',
      'failed to handle updateActiveProcesses',
      () => {
        const { parentStreamId, processes } = data;

        this.state.updateStreamState(parentStreamId, (prev) => {
          const prevIds = new Set(
            prev.activeProcesses.map((p) => p.executionId),
          );
          const nextIds = new Set(processes.map((p) => p.executionId));
          const newlyFinished = [...prevIds].filter(
            (id) => !nextIds.has(id),
          ).length;
          return {
            ...prev,
            activeProcesses: processes,
            finishedProcessCount:
              (prev.finishedProcessCount ?? 0) + newlyFinished,
          };
        });

        if (
          this.webviewUpdater.isAvailable() &&
          parentStreamId === this.state.activeStream
        ) {
          this.webviewUpdater.updateAll(
            this.state,
            StreamStatusService.getAll(),
          );
        }
      },
    );
  };

  private handleSetParentStream = (
    data: ProgressEventPayloads['setParentStream'],
  ): void => {
    withEventErrorHandling(
      'SetParentStream',
      'failed to handle setParentStream',
      () => {
        this.state.setParentStream(data.childStreamId, data.parentStreamId);

        if (this.webviewUpdater.isAvailable()) {
          this.webviewUpdater.updateAll(
            this.state,
            StreamStatusService.getAll(),
          );
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
    const category = this.getStreamCategory(stream);

    const runId =
      runIdHint === undefined ? this.state.getActiveRunId(stream) : runIdHint;

    // Skip update if no runId - frontend can't store instruction without it
    if (!runId) {
      return;
    }

    const existingInstruction = this.state.getRunInstruction(stream, runId);
    const instructionUpdate = WebviewUpdater.createInstructionUpdate(
      taskState,
      existingInstruction?.timestamp,
    );

    // Persist instruction if both runId and instruction exist
    if (instructionUpdate) {
      void this.state.setRunInstruction(stream, runId, instructionUpdate);
    } else {
      void this.state.deleteRunInstruction(stream, runId);
    }

    this.webviewUpdater.updateInstruction(
      stream,
      instructionUpdate ?? null,
      category,
      runId,
    );
  }

  public refreshStreamSurface(
    stream: ActiveStreamId,
    options: { updateInstruction?: boolean } = {},
  ): StorageKey | null {
    if (!this.webviewUpdater.isAvailable()) return null;

    const { updateInstruction = true } = options;

    if (!stream) {
      // Clear the stream surface when no stream is active.
      // The 'clear' action clears all frontend streamStates including queuedFollowUps.
      this.webviewUpdater.updateLogContent('', [], [], undefined, 'clear');
      if (updateInstruction) {
        this.webviewUpdater.updateInstruction('', null);
      }
      return null;
    }

    let messages = this.state.streamTabs.getMessages(stream);
    const groups = [...this.state.taskGroups.getStreamGroups(stream).values()];
    const activeRunId = this.state.getActiveRunId(stream);

    const runInstructions = Object.fromEntries(
      this.state.getRunInstructions(stream).entries(),
    );

    // Legacy fallback: old tool-use sessions saved before beginRunStage()
    // started emitting logger.userMessage() won't have a userMessage log entry.
    // Synthesise one from runInstructions so the instruction still renders.
    if (
      activeRunId &&
      this.getStreamCategory(stream) === AgentCategory.ToolUse &&
      messages[0]?.messageType !== 'userMessage'
    ) {
      const instructionText = runInstructions[activeRunId]?.text?.trim();
      if (instructionText) {
        messages = [
          {
            id: `tool-use-instruction:${activeRunId}`,
            text: instructionText,
            level: 'info',
            timestamp: (messages[0]?.timestamp ?? Date.now()) - 1,
            messageType: 'userMessage',
          },
          ...messages,
        ];
      }
    }

    const runFiles = nestedMapToRecord(this.state.outputFiles.getFiles(stream));
    const runMissingOutputs = nestedMapToRecord(
      this.state.outputFiles.getMissingOutputs(stream),
    ) as Record<string, { [key: number]: string[] }>;
    const runUsage = Object.fromEntries(
      this.state.usageStats.getRunUsage(stream).entries(),
    ) as Record<string, TokenUsageStats>;
    const contextState = this.state.getContextState(stream);
    const todos = this.state.getTodos(stream) ?? [];

    this.pendingTaskGroups.delete(stream);

    this.webviewUpdater.updateLogContent(stream, messages, groups, {
      runInstructions,
      activeRunId,
      runUsage,
      runFiles,
      runMissingOutputs,
      contextState,
    });

    this.webviewUpdater.updateTodos(stream, todos);
    this.webviewUpdater.updateQueuedFollowUps(
      stream,
      ToolUseFollowUpQueue.getAll(stream),
    );

    if (updateInstruction) {
      this.sendInstructionUpdate(stream, activeRunId);
    }

    return activeRunId;
  }

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
      const streamCategory = this.getStreamCategory(streamId);
      if (streamCategory) {
        this.maybeUpdateFilterForCategory(streamCategory);
      }
      const statusesForRefresh = StreamStatusService.getAll();
      statusesForRefresh.set(streamId, status);
      this.webviewUpdater.updateAll(this.state, statusesForRefresh);
    } else {
      const lastTimestamp = this.state.streamTabs.getLastTimestamp(streamId);
      this.webviewUpdater.updateStreamStatus(streamId, status, lastTimestamp);
    }
  }

  private getStreamCategory(streamId: StreamTabId): AgentCategory | undefined {
    const taskState = this.state.getTaskState(streamId);
    return (
      taskState?.agentConfig?.agentCategory ??
      this.state.getStreamHints(streamId).agentCategory
    );
  }

  getAllStreamStatuses(): Map<StreamTabId, StreamStatus> {
    return StreamStatusService.getAll();
  }

  private bufferTaskGroupForReplay(
    streamId: StreamTabId,
    group: TaskGroup,
  ): void {
    const pending = this.pendingTaskGroups.get(streamId) ?? [];
    pending.push(group);
    this.pendingTaskGroups.set(streamId, pending);
  }

  private replayPendingTaskGroups(streamId: StreamTabId): void {
    const pending = this.pendingTaskGroups.get(streamId);
    if (!pending?.length || !this.webviewUpdater.isAvailable()) return;

    for (const group of pending) {
      this.webviewUpdater.addTaskGroup(streamId, group);
    }
    this.pendingTaskGroups.delete(streamId);
  }

  private async initializeStreamForTaskGroup(
    streamId: StreamTabId,
  ): Promise<void> {
    this.state.streamTabs.ensureStream(streamId);

    if (!StreamStatusService.has(streamId)) {
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, { emit: false });
    }

    this.state.updateStreamHints(streamId, {
      agentCategory: AgentCategory.Workflow,
    });
    // Ensure stream state exists so it's included in getAllStreamStates()
    this.state.getOrCreateStreamState(streamId, AgentCategory.Workflow);
    this.maybeUpdateFilterForCategory(AgentCategory.Workflow);
    this.state.activeStream = streamId;

    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    this.webviewUpdater.updateAll(this.state, StreamStatusService.getAll());
    this.refreshStreamSurface(streamId, { updateInstruction: true });
  }

  clearPendingTaskGroups(streamId: StreamTabId): void {
    this.pendingTaskGroups.delete(streamId);
  }

  clearAllPendingTaskGroups(): void {
    this.pendingTaskGroups.clear();
  }

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
