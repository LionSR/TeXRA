// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { OutputFileInfo } from '@agent/output/types';
import type { AgentCategoryFilter } from '@agent/types/AgentStreamTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { StreamStatus } from '@common/constants/streamStatus';
import type { LogMessageData, TaskGroup } from '@logger/LogTypes';
import type { TaskState } from '@logger/TaskState';
import type { InstructionUpdate, StreamTabInfo } from '@progressView/types';

/** Message payload sent to webview */
interface WebviewMessage {
  command: string;
  [key: string]: unknown;
}

// Internal imports
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import { COMMANDS } from '@progressView/modules/constants.js';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
  AgentProposalPrompt,
} from '@eventBus/types';
import type { TodoItem, UpdateTaskGroupPayload } from '@eventBus/schemas';

/**
 * Extra content to include with log updates.
 * All fields are optional to support incremental updates.
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
  contextState?: {
    inputTokens: number;
    contextWindow: number;
    utilizationPercent: number;
  };
}

/**
 * Manages webview updates for the progress view.
 * Provides a clean interface for updating different parts of the webview
 * without coupling business logic to DOM operations.
 * Supports multiple webviews (e.g., sidebar + editor tab panel).
 */
export class WebviewUpdater {
  constructor(private getWebviews: () => (vscode.Webview | undefined)[]) {}

  /** Helper to send messages to all registered webviews */
  private sendMessage(message: WebviewMessage): void {
    for (const webview of this.getWebviews()) {
      if (webview) {
        webview.postMessage(message);
      }
    }
  }

  static createInstructionUpdate(
    taskState?: TaskState,
  ): InstructionUpdate | undefined {
    const text = taskState?.agentConfig?.instruction?.trim();
    if (!text) {
      return undefined;
    }

    const lineCount = text.split(/\r?\n/).length;
    const showToggle = lineCount > 6 || text.length > 600;
    return showToggle ? { text, metadata: { showToggle: true } } : { text };
  }

  /**
   * Update stream tabs in the webview
   */
  updateStreams(
    streams: StreamTabInfo[],
    activeStream: StreamTabId,
    agentFilter: AgentCategoryFilter,
  ): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream,
      agentFilter,
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
    stream: StreamTabId,
    messages: LogMessageData[],
    groups: TaskGroup[] = [],
    extras?: LogContentExtras,
    action: 'render' | 'clear' = 'render',
  ): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_LOGS,
      stream,
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
      command: COMMANDS.APPEND_LOG,
      stream,
      logMessage,
    });
  }

  /**
   * Update an existing log message
   */
  updateLogMessage(stream: StreamTabId, logMessage: LogMessageData): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_LOG,
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
      command: COMMANDS.UPDATE_FILES,
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
      command: COMMANDS.UPDATE_MISSING_OUTPUTS,
      stream,
      ...payload,
    });
  }

  showToolEditApprovalPrompt(prompt: ToolEditApprovalPrompt): void {
    this.sendMessage({
      command: COMMANDS.SHOW_TOOL_EDIT_APPROVAL,
      request: prompt,
    });
  }

  resolveToolEditApprovalPrompt(requestId: string): void {
    this.sendMessage({
      command: COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL,
      requestId,
    });
  }

  updateToolEditApprovalState(stream: StreamTabId, bypassActive: boolean): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE,
      stream,
      bypassActive,
    });
  }

  showRetryRequest(request: RetryRequestPrompt): void {
    this.sendMessage({
      command: COMMANDS.SHOW_RETRY_REQUEST,
      request,
    });
  }

  resolveRetryRequest(streamId: string): void {
    this.sendMessage({
      command: COMMANDS.RESOLVE_RETRY_REQUEST,
      streamId,
    });
  }

  showAgentProposal(proposal: AgentProposalPrompt): void {
    this.sendMessage({
      command: COMMANDS.SHOW_AGENT_PROPOSAL,
      proposal,
    });
  }

  resolveAgentProposal(proposalId: string): void {
    this.sendMessage({
      command: COMMANDS.RESOLVE_AGENT_PROPOSAL,
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
      command: COMMANDS.UPDATE_RUN_USAGE,
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
      command: COMMANDS.UPDATE_CONTEXT_STATE,
      stream,
      contextState,
    });
  }

  /**
   * Update or clear instruction panel content.
   * Pass null for instruction to clear the panel.
   */
  updateInstruction(
    stream: StreamTabId | '',
    instruction: InstructionUpdate | null,
    agentCategory?: string,
  ): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_INSTRUCTION,
      stream,
      instruction,
      agentCategory,
    });
  }

  /**
   * Update the code highlight theme
   */
  updateTheme(theme: 'dark' | 'light'): void {
    this.sendMessage({
      command: COMMANDS.THEME_SET,
      theme,
    });
  }

  /**
   * Update stream status indicator (for active stream)
   */
  updateStatus(status: StreamStatus): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_STATUS,
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
      command: COMMANDS.UPDATE_STREAM_STATUS,
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
      command: COMMANDS.ADD_TASK_GROUP,
      stream,
      group,
    });
  }

  /**
   * Update a task group in the webview
   */
  updateTaskGroup(update: UpdateTaskGroupPayload): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_TASK_GROUP,
      update,
    });
  }

  /**
   * Update the todo list for a stream
   */
  updateTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_TODOS,
      stream,
      todos,
    });
  }

  /**
   * Update the queued follow-ups display for a stream
   */
  updateQueuedFollowUps(stream: StreamTabId, messages: string[]): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_QUEUED_FOLLOW_UPS,
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
    statuses?: Map<string, string>,
    theme?: 'dark' | 'light',
  ): StreamTabId {
    const streams = buildStreamInfos(
      state,
      statuses,
      state.agentCategoryFilter,
    );
    const streamNames = streams.map((info) => info.name);

    // Delegate active stream resolution to state (single source of truth)
    const activeStream = state.resolveActiveStream(streamNames);

    if (!this.isAvailable()) {
      return activeStream;
    }

    if (theme) {
      this.updateTheme(theme);
    }

    this.updateStreams(streams, activeStream, state.agentCategoryFilter);

    return activeStream;
  }

  /**
   * Check if any webview is available
   */
  isAvailable(): boolean {
    return this.getWebviews().some((w) => w !== undefined);
  }
}
