import * as vscode from 'vscode';

import {
  MESSAGE_TYPES,
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
import {
  mapToRecord,
  nestedMapToRecord,
} from '@progressView/persistence/serializationUtils';
import {
  ProgressViewState,
  type ActiveStreamId,
  type StreamExecutionState,
} from '@progressView/state/ProgressViewState';
import { bus } from '@eventBus/ProgressEventBus';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { streamEventQueue } from '@eventBus/StreamEventQueue';

import { registerHandlers } from './registerHandlers';
import { registerUIEvents, type UICallbacks } from './UIEvents';
import type { EventHandlerContext } from './EventHandlerContext';

export type { UICallbacks };

/** Throttle interval for conversation progress webview pushes (ms). */
const PROGRESS_THROTTLE_MS = 500;

type StreamBadgeSnapshot = {
  activeSubagents: StreamExecutionState['activeSubagents'];
  finishedSubagentCount: StreamExecutionState['finishedSubagentCount'];
  activeProcesses: StreamExecutionState['activeProcesses'];
  finishedProcessCount: StreamExecutionState['finishedProcessCount'];
};

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

    // All event handlers — unified registration with automatic error wrapping.
    // Class-level handlers are wrapped as context handlers (ignoring ctx).
    registerHandlers(
      bus,
      this.ctx,
      {
        // Stream lifecycle
        setActiveStream: (_ctx, payload) => this.handleSetActiveStream(payload),
        updateStreamStatus: (_ctx, payload) =>
          this.handleUpdateStreamStatus(payload),
        setTaskState: (_ctx, data) => this.handleSetTaskState(data),
        addTaskGroup: (_ctx, data) => this.handleAddTaskGroup(data),
        updateTaskGroup: (_ctx, data) => this.handleUpdateTaskGroup(data),
        updateConversationProgress: (_ctx, data) =>
          this.handleUpdateConversationProgress(data),
        updateActiveSubagents: (_ctx, data) =>
          this.handleUpdateActiveSubagents(data),
        updateActiveProcesses: (_ctx, data) =>
          this.handleUpdateActiveProcesses(data),
        setParentStream: (_ctx, data) => this.handleSetParentStream(data),
        extensionDeactivating: () => this.markAllRunningTasksAsCancelled(),

        // Log events
        addLogMessage: (ctx, { streamId, logMessage }) => {
          const isNew = ctx.state.streamTabs.addMessage(streamId, logMessage);
          if (isNew) {
            this.sendIfActive(streamId, () =>
              ctx.webviewUpdater.appendLogMessage(streamId, logMessage),
            );
          }
        },
        updateLogMessage: (ctx, { streamId, logMessage }) => {
          if (logMessage.messageType === MESSAGE_TYPES.INTERNAL) return;
          if (!ctx.state.streamTabs.has(streamId)) return;
          const { id: _id, ...updates } = logMessage;
          const existing = ctx.state.streamTabs.updateMessage(
            streamId,
            logMessage.id,
            updates,
            (msg) => msg.messageType !== MESSAGE_TYPES.INTERNAL,
          );
          if (!existing) return;
          this.sendIfActive(streamId, () => {
            const merged = { ...existing, ...updates };
            if (updates.messageType === undefined && existing.messageType) {
              merged.messageType = existing.messageType;
            }
            ctx.webviewUpdater.updateLogMessage(streamId, merged);
          });
        },
        // Output events
        addOutputFiles: async (ctx, { streamId, storageKey, filesByRound }) => {
          await ctx.state.outputFiles.addFiles(
            streamId,
            storageKey,
            filesByRound,
          );
          this.sendIfActive(streamId, () => {
            const runFiles = ctx.state.outputFiles
              .getFiles(streamId)
              .get(storageKey);
            const rounds = runFiles?.size ? mapToRecord(runFiles) : undefined;
            ctx.webviewUpdater.updateFiles(streamId, {
              runId: storageKey,
              rounds,
            });
          });
        },
        updateMissingOutputs: async (
          ctx,
          { streamId, storageKey, filesByRound },
        ) => {
          await ctx.state.outputFiles.updateMissingOutputs(
            streamId,
            storageKey,
            filesByRound,
          );
          this.sendIfActive(streamId, () => {
            const runMissing = ctx.state.outputFiles
              .getMissingOutputs(streamId)
              .get(storageKey);
            const rounds = runMissing?.size
              ? mapToRecord(runMissing)
              : undefined;
            ctx.webviewUpdater.updateMissingOutputs(streamId, {
              runId: storageKey,
              rounds,
            });
          });
        },
        clearMissingOutputs: async (ctx, { streamId }) => {
          await ctx.state.outputFiles.clearMissingOutputs(streamId);
          this.sendIfActive(streamId, () =>
            ctx.webviewUpdater.updateMissingOutputs(streamId, { reset: true }),
          );
        },
        // Usage events
        updateStreamUsage: async (ctx, { streamId, usage, storageKey }) => {
          const accumulated = await ctx.state.usageStats.setRunUsage(
            streamId,
            storageKey,
            usage,
          );
          if (!ctx.state.getActiveRunId(streamId)) {
            ctx.state.setActiveRunId(streamId, storageKey);
          }
          if (accumulated) {
            this.sendIfActive(streamId, () =>
              ctx.webviewUpdater.updateRunUsage(
                streamId,
                storageKey,
                accumulated,
              ),
            );
          }
        },
        updateContextState: (ctx, { streamId, contextState }) => {
          ctx.state.setContextState(streamId, contextState);
          this.sendIfActive(streamId, () =>
            ctx.webviewUpdater.updateContextState(streamId, contextState),
          );
        },
        // Todo events
        updateTodos: (ctx, { streamId, todos }) => {
          ctx.state.setTodos(streamId, todos);
          this.sendIfActive(streamId, () =>
            ctx.webviewUpdater.updateTodos(streamId, todos),
          );
        },
        // Follow-up events
        updateQueuedFollowUps: (ctx, { streamId }) => {
          this.sendIfActive(streamId, () => {
            const messages = ToolUseFollowUpQueue.getAll(streamId);
            ctx.webviewUpdater.updateQueuedFollowUps(streamId, messages);
          });
        },
      },
      signal,
      'ProgressEvents',
    );

    // UI callback handlers (different pattern — no state, no active-stream guard)
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

  /** Send to webview only if streamId is the active stream. */
  private sendIfActive(streamId: string, send: () => void): void {
    if (
      streamId === this.state.activeStream &&
      this.webviewUpdater.isAvailable()
    ) {
      send();
    }
  }

  private handleSetActiveStream(
    payload: ProgressEventPayloads['setActiveStream'],
  ): void {
    const { streamId, agentCategory, isRemote, hasMultipleOutputs } = payload;
    if (!streamId) return;

    const wasKnownStream = this.state.streamTabs.has(streamId);
    const previousFilter = this.state.agentCategoryFilter;
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

    const filterChanged = this.state.agentCategoryFilter !== previousFilter;
    if (!wasKnownStream || filterChanged) {
      this.webviewUpdater.sendStreamMetadata(
        this.state,
        StreamStatusService.getAll(),
      );
    } else {
      this.webviewUpdater.setActiveStream(streamId);
    }
    // Known-stream path: include active-stream state in the batch
    // so we don't need separate progress/badges/parent messages.
    this.syncStreamContent(streamId, {
      updateInstruction: true,
      includeActiveState: wasKnownStream && !filterChanged,
    });
  }

  private handleUpdateStreamStatus(
    payload: ProgressEventPayloads['updateStreamStatus'],
  ): void {
    this.setStreamStatus(
      payload.streamId,
      payload.status,
      payload.previousStatus,
    );
  }

  private handleSetTaskState(
    data: ProgressEventPayloads['setTaskState'],
  ): void {
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
      const filterChanged = this.state.agentCategoryFilter !== previousFilter;
      if (filterChanged || isActiveStream) {
        // sendStreamMetadata rebuilds StreamTabInfo[] for all visible streams.
        // This fires once per run start (not during streaming) so the O(N)
        // cost is acceptable. We need it here because setTaskState may change
        // agentConfig (agent name, model, label) which the frontend tabs display.
        this.webviewUpdater.sendStreamMetadata(
          this.state,
          StreamStatusService.getAll(),
        );
      }
    }
  }

  private handleAddTaskGroup(
    data: ProgressEventPayloads['addTaskGroup'],
  ): void {
    streamEventQueue.enqueue(data.streamId, () =>
      this.processAddTaskGroup(data),
    );
  }

  private async processAddTaskGroup(
    data: ProgressEventPayloads['addTaskGroup'],
  ): Promise<void> {
    const { streamId, ...group } = data;
    const { id, parentGroupId } = group;

    const hasStream = this.state.streamTabs.has(streamId);
    // Await persistence before sending to webview so intent matches code structure.
    await this.state.addTaskGroup(streamId, id, group);

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
  }

  private handleUpdateTaskGroup(
    data: ProgressEventPayloads['updateTaskGroup'],
  ): void {
    streamEventQueue.enqueue(data.streamId, () =>
      this.processUpdateTaskGroup(data),
    );
  }

  private async processUpdateTaskGroup(
    data: ProgressEventPayloads['updateTaskGroup'],
  ): Promise<void> {
    const groups = this.state.getTaskGroups(data.streamId);
    if (!groups.has(data.id)) {
      // StreamEventQueue serializes events per stream, so addTaskGroup always
      // completes before updateTaskGroup. If we hit this, there's a bug.
      this.logger.warn(
        `updateTaskGroup for unknown group ${data.id} in stream ${data.streamId}`,
      );
      return;
    }

    await this.state.updateTaskGroup(data);

    const isActive = data.streamId === this.state.activeStream;
    if (this.webviewUpdater.isAvailable() && isActive) {
      this.webviewUpdater.updateTaskGroup(data);
    }
  }

  private handleUpdateConversationProgress(
    data: ProgressEventPayloads['updateConversationProgress'],
  ): void {
    const { streamId, progress } = data;

    // Always update state immediately so full metadata rebuilds include
    // the latest values when structural refreshes happen.
    this.state.updateStreamState(streamId, (prev) => ({
      ...prev,
      conversationProgress: progress,
    }));

    // Throttle webview pushes: buffer per-stream, flush on timer
    this.pendingProgressUpdates.set(streamId, progress);
    if (!this.progressThrottleTimer) {
      this.progressThrottleTimer = setTimeout(
        () => this.flushProgressUpdates(),
        PROGRESS_THROTTLE_MS,
      );
    }
  }

  private flushProgressUpdates(): void {
    this.progressThrottleTimer = null;
    if (
      this.pendingProgressUpdates.size === 0 ||
      !this.webviewUpdater.isAvailable()
    ) {
      this.pendingProgressUpdates.clear();
      return;
    }

    // Push a targeted update only for the active stream.
    const activeStream = this.state.activeStream;
    const progress = activeStream
      ? this.pendingProgressUpdates.get(activeStream)
      : undefined;
    if (activeStream && progress) {
      this.webviewUpdater.updateConversationProgress(activeStream, progress);
    }
    this.pendingProgressUpdates.clear();
  }

  private handleUpdateActiveSubagents(
    data: ProgressEventPayloads['updateActiveSubagents'],
  ): void {
    this.updateActiveChildren(data.parentStreamId, {
      activeField: 'activeSubagents',
      countField: 'finishedSubagentCount',
      next: data.children,
    });
  }

  private handleUpdateActiveProcesses(
    data: ProgressEventPayloads['updateActiveProcesses'],
  ): void {
    this.updateActiveChildren(data.parentStreamId, {
      activeField: 'activeProcesses',
      countField: 'finishedProcessCount',
      next: data.processes,
    });
  }

  private updateActiveChildren(
    parentStreamId: StreamTabId,
    opts: {
      activeField: 'activeSubagents' | 'activeProcesses';
      countField: 'finishedSubagentCount' | 'finishedProcessCount';
      next: StreamExecutionState['activeSubagents'];
    },
  ): void {
    let nextBadges: StreamBadgeSnapshot | null = null;

    this.state.updateStreamState(parentStreamId, (prev) => {
      const prevIds = new Set(prev[opts.activeField].map((c) => c.executionId));
      const nextIds = new Set(opts.next.map((c) => c.executionId));
      const newlyFinished = [...prevIds].filter(
        (id) => !nextIds.has(id),
      ).length;
      const updatedState = {
        ...prev,
        [opts.activeField]: opts.next,
        [opts.countField]: (prev[opts.countField] ?? 0) + newlyFinished,
      };
      nextBadges = {
        activeSubagents: updatedState.activeSubagents,
        finishedSubagentCount: updatedState.finishedSubagentCount,
        activeProcesses: updatedState.activeProcesses,
        finishedProcessCount: updatedState.finishedProcessCount,
      };
      return updatedState;
    });

    if (
      this.webviewUpdater.isAvailable() &&
      parentStreamId === this.state.activeStream &&
      nextBadges
    ) {
      this.webviewUpdater.updateStreamBadges(parentStreamId, nextBadges);
    }
  }

  private handleSetParentStream(
    data: ProgressEventPayloads['setParentStream'],
  ): void {
    this.state.setParentStream(data.childStreamId, data.parentStreamId);

    if (this.webviewUpdater.isAvailable()) {
      this.webviewUpdater.updateParentStream(
        data.childStreamId,
        data.parentStreamId,
      );
    }
  }

  private markAllRunningTasksAsCancelled(): void {
    for (const [stream, status] of StreamStatusService.entries()) {
      if (status === STREAM_STATUS.RUNNING) {
        StreamStatusService.set(stream, STREAM_STATUS.STOPPED, { emit: false });
      }
    }
  }

  private sendInstructionUpdate(
    stream: StreamTabId | '',
    runIdHint?: StorageKey | null,
  ): void {
    if (!this.webviewUpdater.isAvailable()) return;

    if (!stream) {
      this.webviewUpdater.updateInstruction('', null);
      return;
    }

    const { instruction, agentCategory, runId } = this.prepareInstructionUpdate(
      stream,
      runIdHint,
    );
    if (!runId) return;

    this.webviewUpdater.updateInstruction(
      stream,
      instruction,
      agentCategory,
      runId,
    );
  }

  public syncStreamContent(
    stream: ActiveStreamId,
    options: {
      updateInstruction?: boolean;
      /** Include conversation progress, badges, and parent stream in the batch. */
      includeActiveState?: boolean;
    } = {},
  ): StorageKey | null {
    if (!this.webviewUpdater.isAvailable()) return null;

    const { updateInstruction = true, includeActiveState = false } = options;

    if (!stream) {
      // Clear the stream surface when no stream is active.
      this.webviewUpdater.sendSyncStreamContent({
        stream: '',
        messages: [],
        groups: [],
        extras: { activeRunId: null },
        action: 'clear',
        todos: [],
        queuedFollowUps: [],
        instruction: null,
      });
      return null;
    }

    // Gather all content in one pass
    const { messages, groups, extras, activeRunId } =
      this.prepareStreamLogs(stream);
    const todos = this.state.getTodos(stream);
    const queuedFollowUps = ToolUseFollowUpQueue.getAll(stream);

    let instruction: import('@shared/schemas').InstructionUpdate | null = null;
    let agentCategory: string | undefined;
    let runId: StorageKey | null = null;
    if (updateInstruction) {
      ({ instruction, agentCategory, runId } = this.prepareInstructionUpdate(
        stream,
        activeRunId,
      ));
    }

    // Optionally include active-stream state (replaces syncActiveStreamState).
    let conversationProgress:
      | import('@shared/schemas').ConversationProgress
      | undefined;
    let badges: StreamBadgeSnapshot | undefined;
    let parentStreamId: StreamTabId | undefined;
    if (includeActiveState) {
      const streamState = this.state.getStreamState(stream);
      if (streamState) {
        conversationProgress = streamState.conversationProgress;
        badges = {
          activeSubagents: streamState.activeSubagents,
          finishedSubagentCount: streamState.finishedSubagentCount,
          activeProcesses: streamState.activeProcesses,
          finishedProcessCount: streamState.finishedProcessCount,
        };
      }
      parentStreamId = this.state.getParentStreamId(stream);
    }

    this.webviewUpdater.sendSyncStreamContent({
      stream,
      messages,
      groups,
      extras,
      todos,
      queuedFollowUps,
      instruction,
      agentCategory,
      runId,
      conversationProgress,
      badges,
      parentStreamId,
    });

    return activeRunId;
  }

  /** Gather log content without sending. Used by batched hydration. */
  private prepareStreamLogs(stream: StreamTabId): {
    messages: import('@shared/schemas').LogMessageData[];
    groups: import('@shared/schemas').TaskGroup[];
    extras: import('@progressView/managers/WebviewUpdater').LogContentExtras;
    activeRunId: StorageKey | null;
  } {
    let messages = this.state.streamTabs.getMessages(stream);
    const groups = [...this.state.getTaskGroups(stream).values()];
    const activeRunId = this.state.getActiveRunId(stream);

    const runInstructions = Object.fromEntries(
      this.state.getRunInstructions(stream).entries(),
    );

    // Legacy fallback: old tool-use sessions saved before beginRunStage()
    // started emitting logger.userMessage() won't have a userMessage log entry.
    // Synthesise one from runInstructions so the instruction still renders.
    if (
      activeRunId &&
      this.getStreamCategory(stream) === AgentCategory.ToolUse
    ) {
      const instructionText = runInstructions[activeRunId]?.text?.trim();
      if (
        instructionText &&
        !messages.some(
          (m) =>
            m.messageType === 'userMessage' &&
            m.text?.trim() === instructionText,
        )
      ) {
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

    this.pendingTaskGroups.delete(stream);

    return {
      messages,
      groups,
      extras: {
        runInstructions,
        activeRunId,
        runUsage,
        runFiles,
        runMissingOutputs,
        contextState,
      },
      activeRunId,
    };
  }

  /** Gather instruction update data without sending. Used by batched hydration. */
  private prepareInstructionUpdate(
    stream: StreamTabId,
    runIdHint?: StorageKey | null,
  ): {
    instruction: import('@shared/schemas').InstructionUpdate | null;
    agentCategory?: string;
    runId: StorageKey | null;
  } {
    const taskState = this.state.getTaskState(stream);
    const category = this.getStreamCategory(stream);
    const runId =
      runIdHint === undefined ? this.state.getActiveRunId(stream) : runIdHint;

    if (!runId) {
      return { instruction: null, runId: null };
    }

    const existingInstruction = this.state.getRunInstruction(stream, runId);
    const instructionUpdate = WebviewUpdater.createInstructionUpdate(
      taskState,
      existingInstruction?.timestamp,
    );

    // Persist instruction
    if (instructionUpdate) {
      void this.state.setRunInstruction(stream, runId, instructionUpdate);
    } else {
      void this.state.setRunInstruction(stream, runId, null);
    }

    return {
      instruction: instructionUpdate ?? null,
      agentCategory: category,
      runId,
    };
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
      this.state.streamTabs.ensureStream(streamId);
    }
    // Persisted streams may be in streamTabs but missing from _streamStates;
    // getOrCreateStreamState is idempotent so safe to call unconditionally.
    const category = this.getStreamCategory(streamId) ?? AgentCategory.Workflow;
    this.state.getOrCreateStreamState(streamId, category);

    if (!streamExists) {
      const streamCategory = this.getStreamCategory(streamId);
      if (streamCategory) {
        this.maybeUpdateFilterForCategory(streamCategory);
      }
      const statusesForRefresh = StreamStatusService.getAll();
      statusesForRefresh.set(streamId, status);
      this.webviewUpdater.sendStreamMetadata(this.state, statusesForRefresh);
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

    this.webviewUpdater.sendStreamMetadata(
      this.state,
      StreamStatusService.getAll(),
    );
    this.syncStreamContent(streamId, { updateInstruction: true });
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
