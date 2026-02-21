import * as vscode from 'vscode';

import { STREAM_STATUS } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import type { TaskState } from '@logger/TaskState';
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  AgentCategoryFilter,
  ConversationProgress,
  ContextState,
  InstructionUpdate,
  LogMessageData,
  OutputFileInfo,
  PermissionPayload,
  ProgressPermissionKind,
  ProgressViewOutboundMessage,
  StreamMetadata,
  StreamState,
  StreamStatus,
  StreamTabId,
  StreamTabInfo,
  TaskGroup,
  TodoItem,
  TokenUsageStats,
  UpdateTaskGroupPayload,
  StorageKey,
} from '@shared/schemas';

/**
 * Extra content to include with log updates.
 * All fields are optional to support incremental updates.
 *
 * NOTE: Status/todos/instruction are sent as separate messages rather than
 * batched here. This ensures critical UI feedback (status) isn't blocked by
 * potentially large log payloads and provides fault isolation.
 */
export interface LogContentExtras {
  /** Instructions by run ID */
  runInstructions?: Record<string, InstructionUpdate>;
  /** Currently active run ID */
  activeRunId?: string | null;
  /** Usage stats by run ID */
  runUsage?: Record<string, TokenUsageStats>;
  /** Output files by run ID and round */
  runFiles?: Record<string, { [key: number]: OutputFileInfo[] }>;
  /** Missing outputs by run ID and round (batched with initial render) */
  runMissingOutputs?: Record<string, { [key: number]: string[] }>;
  /** Context window utilization state */
  contextState?: ContextState;
}

/** Payload for batched stream content hydration (tab switch). */
export interface SyncStreamContentPayload {
  stream: StreamTabId | '';
  messages: LogMessageData[];
  groups: TaskGroup[];
  extras?: LogContentExtras;
  action?: 'render' | 'clear';
  todos: TodoItem[];
  queuedFollowUps: string[];
  instruction: InstructionUpdate | null;
  agentCategory?: string;
  runId?: StorageKey | null;
}

/**
 * Manages webview updates for the progress view.
 * Provides a clean interface for updating different parts of the webview
 * without coupling business logic to DOM operations.
 * Supports multiple webviews (e.g., sidebar + editor tab panel).
 */
export class WebviewUpdater {
  constructor(private getWebviews: () => (vscode.Webview | undefined)[]) {}

  /**
   * Helper to send typed messages to all registered webviews.
   * Uses ProgressViewOutboundMessage union type for compile-time safety.
   */
  private sendMessage(message: ProgressViewOutboundMessage): void {
    for (const webview of this.getWebviews()) {
      if (webview) {
        webview.postMessage(message);
      }
    }
  }

  static createInstructionUpdate(
    taskState?: TaskState,
    existingTimestamp?: number,
  ): InstructionUpdate | undefined {
    const text = taskState?.agentConfig?.instruction?.trim();
    if (!text) {
      return undefined;
    }

    const lineCount = text.split(/\r?\n/).length;
    const timestamp = existingTimestamp ?? Date.now();
    const showToggle = lineCount > 6 || text.length > 600;
    if (showToggle) {
      return { text, metadata: { showToggle: true }, timestamp };
    }
    return { text, timestamp };
  }

  /**
   * Update stream tabs in the webview.
   * Optionally includes lightweight stream metadata (backend-owned fields only).
   */
  updateStreams(
    streams: StreamTabInfo[],
    activeStream: StreamTabId,
    agentFilter: AgentCategoryFilter,
    streamStates?: Record<StreamTabId, StreamMetadata>,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream,
      agentFilter,
      streamStates,
    });
  }

  /**
   * Update log content for a specific stream.
   *
   * Action types:
   * - `'render'` (default): Send data to display. Frontend detects stream switch
   *   by comparing message.stream with its lastRenderedStream. If stream changed,
   *   frontend clears and rebuilds. If same stream, frontend does incremental update.
   * - `'clear'`: Explicitly clear DOM content (for stream deletion, no active stream).
   *   Frontend always clears, even without messages.
   *
   * This design moves stream switch detection to the frontend (which tracks
   * lastRenderedStream) and removes the need for backend to track render state.
   *
   * @param action - The action type: 'render' (default) or 'clear'
   */
  updateLogContent(
    streamId: StreamTabId,
    messages: LogMessageData[],
    groups: TaskGroup[] = [],
    extras?: LogContentExtras,
    action: 'render' | 'clear' = 'render',
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_LOGS,
      stream: streamId,
      messages,
      groups,
      ...extras,
      action,
    });
  }

  /**
   * Append a single log message to a stream
   */
  appendLogMessage(stream: StreamTabId, logMessage: LogMessageData): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.APPEND_LOG,
      stream,
      logMessage,
    });
  }

  /**
   * Update an existing log message
   */
  updateLogMessage(stream: StreamTabId, logMessage: LogMessageData): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_LOG,
      stream,
      logMessage,
    });
  }

  /**
   * Update output files for a stream
   */
  updateFiles(
    stream: StreamTabId,
    payload: {
      runId?: string;
      rounds?: { [key: number]: OutputFileInfo[] };
      reset?: boolean;
    },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
      stream,
      ...payload,
    });
  }

  /**
   * Update missing outputs for a stream
   */
  updateMissingOutputs(
    stream: StreamTabId,
    payload: {
      runId?: string;
      rounds?: { [key: number]: string[] };
      reset?: boolean;
    },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
      stream,
      ...payload,
    });
  }

  showPermission(permission: PermissionPayload): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
      action: 'show',
      permission,
    });
  }

  resolvePermission(kind: ProgressPermissionKind, id: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
      action: 'resolve',
      kind,
      id,
    });
  }

  updateBypassState(
    stream: StreamTabId,
    type: 'toolEdit' | 'superYolo',
    bypassActive: boolean,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS,
      stream,
      type,
      bypassActive,
    });
  }

  /** Update usage for a single run (incremental). */
  updateRunUsage(
    stream: StreamTabId,
    runId: string,
    usage: TokenUsageStats,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE,
      stream,
      runId,
      usage,
    });
  }

  /**
   * Update context utilization display in the footer.
   * Shows "X% context left" based on current input tokens vs context window.
   */
  updateContextState(
    stream: StreamTabId,
    contextState: {
      inputTokens: number;
      contextWindow: number;
      utilizationPercent: number;
    },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE,
      stream,
      contextState,
    });
  }

  /**
   * Update or clear instruction panel content.
   * Pass null for instruction to clear the panel.
   * @param runId - When provided, frontend uses this directly instead of resolving from state.
   */
  updateInstruction(
    stream: StreamTabId | '',
    instruction: InstructionUpdate | null,
    agentCategory?: string,
    runId?: string | null,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION,
      stream,
      instruction,
      agentCategory,
      runId,
    });
  }

  /**
   * Update the code highlight theme
   */
  updateTheme(theme: 'dark' | 'light'): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.THEME_SET,
      theme,
    });
  }

  /**
   * Update a single stream's status in the stream tabs.
   * More efficient than updateStreams when only status changed.
   * @param lastTimestamp - Optional timestamp for updating "last activity" display
   */
  updateStreamStatus(
    stream: StreamTabId,
    status: StreamStatus,
    lastTimestamp?: number,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream,
      status,
      lastTimestamp,
    });
  }

  setActiveStream(activeStream: StreamTabId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream,
    });
  }

  /** Send lightweight delete notification to all webviews (dual-webview sync). */
  deleteStream(stream: StreamTabId): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream,
    });
  }

  updateConversationProgress(
    stream: StreamTabId,
    progress: ConversationProgress,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS,
      stream,
      progress,
    });
  }

  updateStreamBadges(
    stream: StreamTabId,
    badges: {
      activeSubagents: StreamState['activeSubagents'];
      finishedSubagentCount: StreamState['finishedSubagentCount'];
      activeProcesses: StreamState['activeProcesses'];
      finishedProcessCount: StreamState['finishedProcessCount'];
    },
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
      stream,
      ...badges,
    });
  }

  updateParentStream(
    stream: StreamTabId,
    parentStreamId: StreamTabId | undefined,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM,
      stream,
      parentStreamId,
    });
  }

  /**
   * Add a task group to the webview
   */
  addTaskGroup(stream: StreamTabId, group: TaskGroup): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP,
      stream,
      group,
    });
  }

  /**
   * Update a task group in the webview
   */
  updateTaskGroup(update: UpdateTaskGroupPayload): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP,
      update,
    });
  }

  /**
   * Update the todo list for a stream
   */
  updateTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
      stream,
      todos,
    });
  }

  /**
   * Update the queued follow-ups display for a stream
   */
  updateQueuedFollowUps(stream: StreamTabId, messages: string[]): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS,
      stream,
      messages,
    });
  }

  /**
   * Send a single batched content sync message combining logs, todos, follow-ups,
   * and instruction. Used on tab switch to replace 4 separate messages with 1.
   */
  sendSyncStreamContent(payload: SyncStreamContentPayload): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      stream: payload.stream,
      messages: payload.messages,
      groups: payload.groups,
      action: payload.action,
      ...payload.extras,
      todos: payload.todos,
      queuedFollowUps: payload.queuedFollowUps,
      instruction: payload.instruction,
      agentCategory: payload.agentCategory,
      runId: payload.runId,
    });
  }

  /**
   * Update stream metadata and theme for the webview.
   * Returns the active stream after applying the update.
   *
   * Note: This method computes valid active stream via ProgressViewState
   * (single source of truth) and explicitly persists if changed.
   *
   * Use this for structural updates (initial sync, filter changes, stream add/remove).
   * For incremental updates, prefer targeted messages like:
   * setActiveStream(), updateConversationProgress(), updateStreamBadges(),
   * updateParentStream(), updateStreamStatus().
   */
  sendStreamMetadata(
    state: ProgressViewState,
    statuses?: Map<string, StreamStatus>,
    theme?: 'dark' | 'light',
  ): StreamTabId {
    const streams = buildStreamInfos(state, state.agentCategoryFilter);
    const streamNames = streams.map((info) => info.name);

    // Compute valid active stream (pure query) and persist if changed
    const activeStream = state.pickValidActiveStream(streamNames);
    if (activeStream !== state.activeStream) {
      state.activeStream = activeStream;
    }

    if (!this.isAvailable()) {
      return activeStream;
    }

    if (theme) {
      this.updateTheme(theme);
    }

    // Send lightweight metadata — only backend-owned fields the frontend merges.
    // Full StreamState objects (taskGroups, runInstructions, runUsage, etc.) are
    // never needed here; the frontend populates those via targeted messages.
    const allStates = state.getAllStreamStates();
    const streamMetadata: Record<StreamTabId, StreamMetadata> = {};
    for (const streamInfo of streams) {
      const current = allStates[streamInfo.name];
      const status = statuses?.get(streamInfo.name) ?? STREAM_STATUS.READY;
      const lastTimestamp = state.streamTabs.getLastTimestamp(streamInfo.name);
      streamMetadata[streamInfo.name] = {
        kind: streamInfo.agentCategory,
        status,
        lastTimestamp,
        conversationProgress: current?.conversationProgress ?? { conversationTurns: 0, toolCallCount: 0 },
        activeSubagents: current?.activeSubagents ?? [],
        finishedSubagentCount: current?.finishedSubagentCount ?? 0,
        activeProcesses: current?.activeProcesses ?? [],
        finishedProcessCount: current?.finishedProcessCount ?? 0,
      };
    }

    this.updateStreams(
      streams,
      activeStream,
      state.agentCategoryFilter,
      streamMetadata,
    );

    return activeStream;
  }

  /**
   * Check if any webview is available
   */
  isAvailable(): boolean {
    return this.getWebviews().some((w) => w !== undefined);
  }
}
