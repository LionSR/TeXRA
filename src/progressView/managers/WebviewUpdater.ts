import * as vscode from 'vscode';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import type { TaskState } from '@logger/TaskState';
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  AgentCategoryFilter,
  AgentProposalPermission,
  BashPermission,
  ContextState,
  InstructionUpdate,
  LogMessageData,
  OutputFileInfo,
  ProgressViewOutboundMessage,
  RetryPermission,
  StreamState,
  StreamStatus,
  StreamTabId,
  StreamTabInfo,
  TaskGroup,
  TodoItem,
  TokenUsageStats,
  ToolEditPermission,
  UpdateTaskGroupPayload,
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
    const showToggle = lineCount > 6 || text.length > 600;
    // Preserve existing timestamp or set new one when instruction is first created
    const timestamp = existingTimestamp ?? Date.now();
    return showToggle
      ? { text, metadata: { showToggle: true }, timestamp }
      : { text, timestamp };
  }

  /**
   * Update stream tabs in the webview.
   * Optionally includes full stream states - backend is source of truth.
   */
  updateStreams(
    streams: StreamTabInfo[],
    activeStream: StreamTabId,
    agentFilter: AgentCategoryFilter,
    streamStates?: Record<StreamTabId, StreamState>,
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

  showToolEditPermission(permission: ToolEditPermission): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL,
      request: permission,
    });
  }

  resolveToolEditPermission(requestId: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL,
      requestId,
    });
  }

  updateToolEditApprovalState(
    stream: StreamTabId,
    bypassActive: boolean,
  ): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE,
      stream,
      bypassActive,
    });
  }

  showBashPermission(permission: BashPermission): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL,
      request: permission,
    });
  }

  resolveBashPermission(requestId: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL,
      requestId,
    });
  }

  showRetryRequest(request: RetryPermission): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST,
      request,
    });
  }

  resolveRetryRequest(streamId: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST,
      streamId,
    });
  }

  showAgentProposal(proposal: AgentProposalPermission): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL,
      proposal,
    });
  }

  resolveAgentProposal(proposalId: string): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL,
      proposalId,
    });
  }

  /**
   * Update usage for a single run (incremental).
   * More efficient than updateUsage when only one run's usage changed.
   */
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
   * Update stream status indicator (for active stream)
   */
  updateStatus(status: StreamStatus): void {
    this.sendMessage({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STATUS,
      status,
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
   * Update stream metadata and theme for the webview.
   * Returns the active stream after applying the update.
   *
   * Note: This method delegates active stream resolution to ProgressViewState,
   * which is the single source of truth. The WebviewUpdater only reads state
   * and sends messages - it never mutates state.
   */
  updateAll(
    state: ProgressViewState,
    statuses?: Map<string, StreamStatus>,
    theme?: 'dark' | 'light',
  ): StreamTabId {
    const streams = buildStreamInfos(
      state,
      statuses,
      state.agentCategoryFilter,
    );
    const streamNames = streams.map((info) => info.name);

    // Delegate active stream validation to state (single source of truth)
    const activeStream = state.ensureValidActiveStream(streamNames);

    if (!this.isAvailable()) {
      return activeStream;
    }

    if (theme) {
      this.updateTheme(theme);
    }

    // Send stream states - backend is the source of truth
    const streamStates = state.getAllStreamStates();

    this.updateStreams(
      streams,
      activeStream,
      state.agentCategoryFilter,
      streamStates,
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
