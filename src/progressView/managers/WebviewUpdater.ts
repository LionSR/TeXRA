// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';
// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';

import { type StreamStatus } from '@common/constants/streamStatus';
import { LogMessageData } from '@logger/LogTypes';
import type { TaskState } from '@logger/TaskState';
import type { InstructionUpdate, StreamTabInfo } from '@progressView/types';
// Internal imports
import { buildStreamInfos } from '@progressView/streamInfoUtils';
import { progressViewLogger } from '@progressView/progressViewLogger';

// Internal imports
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { COMMANDS } from '@progressView/modules/constants.js';
import type {
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
} from '@eventBus/types';
import type { TodoItem, UpdateTaskGroupPayload } from '@eventBus/schemas';

// Logger imports
// Type imports

/**
 * Manages webview updates for the progress view.
 * Provides a clean interface for updating different parts of the webview
 * without coupling business logic to DOM operations.
 */
export class WebviewUpdater {
  constructor(private getWebview: () => vscode.Webview | undefined) {}

  /** Helper to send messages to webview, eliminating repetitive null checks */
  private sendMessage(message: any): void {
    const webview = this.getWebview();
    if (!webview) return;
    webview.postMessage(message);
  }

  static createInstructionUpdate(
    taskState?: TaskState,
  ): InstructionUpdate | undefined {
    if (!taskState) {
      return undefined;
    }

    const text = taskState.agentConfig?.instruction ?? '';
    const normalized = text.trim();
    if (!normalized) {
      return undefined;
    }

    const metadata = WebviewUpdater.computeInstructionMetadata(normalized);
    const payload: InstructionUpdate = { text: normalized };
    if (metadata) {
      payload.metadata = metadata;
    }
    return payload;
  }

  private static computeInstructionMetadata(
    text: string,
  ): InstructionUpdate['metadata'] | undefined {
    const lineCount = text.split(/\r?\n/).length;
    const shouldShowToggle = lineCount > 6 || text.length > 600;
    if (!shouldShowToggle) {
      return undefined;
    }
    return { showToggle: true };
  }

  /**
   * Update stream tabs in the webview
   */
  updateStreams(
    streams: StreamTabInfo[],
    activeStream: StreamTabId,
    agentFilter: AgentTypeFilter,
  ): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream,
      agentFilter,
    });
  }

  /**
   * Update log content for a specific stream
   * @param options.forceRebuild - Controls frontend DOM rebuild behavior:
   *   - `true`: Full DOM rebuild (required when switching streams or after data deletion)
   *   - `false`: Incremental update only (skip DOM rebuild, update metadata)
   *   - `undefined`: Full DOM rebuild (legacy behavior, same as true)
   *   Note: Frontend uses strict `=== false` check, so explicit `false` is required
   *   for incremental updates.
   */
  updateLogContent(
    stream: StreamTabId,
    messages: LogMessageData[],
    groups: any[] = [],
    extras?: {
      runInstructions?: Record<string, InstructionUpdate>;
      activeRunId?: string | null;
      runUsage?: Record<string, TokenUsageStats>;
      runFiles?: Record<string, { [key: number]: OutputFileInfo[] }>;
    },
    options?: {
      forceRebuild?: boolean;
    },
  ): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_LOGS,
      stream,
      messages,
      groups,
      runInstructions: extras?.runInstructions,
      activeRunId: extras?.activeRunId,
      runUsage: extras?.runUsage,
      runFiles: extras?.runFiles,
      forceRebuild: options?.forceRebuild,
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

  updateToolEditApprovalState(bypassActive: boolean): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE,
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

  /**
   * Update usage statistics (full replacement)
   */
  updateUsage(
    stream: StreamTabId,
    usageByRun: Record<string, TokenUsageStats>,
  ): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_USAGE,
      stream,
      usageByRun,
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
   * Update or clear instruction panel content.
   * Pass null for instruction to clear the panel.
   */
  updateInstruction(
    stream: StreamTabId | '',
    instruction: InstructionUpdate | null,
    sessionKind?: string,
  ): void {
    this.sendMessage({
      command: COMMANDS.UPDATE_INSTRUCTION,
      stream,
      instruction,
      sessionKind,
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
  addTaskGroup(stream: StreamTabId, group: any): void {
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
    const streams = buildStreamInfos(state, statuses, state.agentTypeFilter);
    const streamNames = streams.map((info) => info.name);

    // Delegate active stream resolution to state (single source of truth)
    const activeStream = state.resolveActiveStream(streamNames);

    if (!this.getWebview()) {
      return activeStream;
    }

    if (theme) {
      this.updateTheme(theme);
    }

    this.updateStreams(streams, activeStream, state.agentTypeFilter);

    progressViewLogger.debug(
      `Updated webview streams (${streams.length}) active: ${activeStream}`,
    );

    return activeStream;
  }

  /**
   * Check if webview is available
   */
  isAvailable(): boolean {
    return this.getWebview() !== undefined;
  }
}
