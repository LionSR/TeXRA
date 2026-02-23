import * as vscode from 'vscode';

import {
  MESSAGE_TYPES,
  STREAM_STATUS,
  type ConversationProgress,
  type StorageKey,
  type StreamStatus,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { AgentLogger } from '@logger/AgentLogger';
import { WebviewBridge } from '@progressView/managers/WebviewBridge';
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
  private readonly ctx: EventHandlerContext;
  private progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProgressUpdates = new Map<StreamTabId, ConversationProgress>();

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
    private webviewBridge: WebviewBridge,
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
        // Stream lifecycle — these handlers use this.state/this.webviewUpdater
        // (same objects as ctx), so ctx is unused but required by the signature.
        setActiveStream: (_, payload) => this.handleSetActiveStream(payload),
        updateStreamStatus: (_, payload) =>
          this.handleUpdateStreamStatus(payload),
        setTaskState: (_, data) => this.handleSetTaskState(data),
        updateConversationProgress: (_, data) =>
          this.handleUpdateConversationProgress(data),
        updateActiveSubagents: (_, data) =>
          this.handleUpdateActiveSubagents(data),
        updateActiveProcesses: (_, data) =>
          this.handleUpdateActiveProcesses(data),
        setParentStream: (_, data) => this.handleSetParentStream(data),
        extensionDeactivating: () => this.markAllRunningTasksAsCancelled(),
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
        this.webviewBridge.clearAll();
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

    const wasKnownStream = this.state.streamLogs.has(streamId);
    const previousFilter = this.state.agentCategoryFilter;
    this.state.streamLogs.ensureStream(streamId);
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
        action: 'clear',
        activeRunId: null,
        todos: [],
        queuedFollowUps: [],
        instruction: null,
      });
      return null;
    }

    this.webviewBridge.syncStream(stream);

    const { extras, activeRunId } = this.prepareStreamSyncExtras(stream);
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
      action: 'render',
      ...extras,
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

  private prepareStreamSyncExtras(stream: StreamTabId): {
    extras: import('@progressView/managers/WebviewUpdater').LogContentExtras;
    activeRunId: StorageKey | null;
  } {
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

    return {
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

    const streamExists = this.state.streamLogs.has(streamId);
    if (!streamExists) {
      this.state.streamLogs.ensureStream(streamId);
    }
    // Persisted streams may be in stream logs but missing from _streamStates;
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
      const lastTimestamp = this.state.streamLogs.getLastTimestamp(streamId);
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
        `Stream ${streamId} set to ERROR during restart recovery`,
      );
    }

    return affectedStreams;
  }
}
