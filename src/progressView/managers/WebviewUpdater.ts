// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';
// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';

import { type StreamStatus } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';
import { LogMessageData } from '@logger/LogTypes';
import type { TaskState } from '@logger/TaskState';
import type { InstructionUpdate, StreamTabInfo } from '@progressView/types';
// Internal imports
import { buildStreamInfos } from '@progressView/streamInfoUtils';

// Type imports
import type { TaskGroupUpdatePayload } from '@progressView/managers/TaskGroupManager';
// Internal imports
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { COMMANDS } from '@progressView/modules/constants.js';
import type {
  RetryRequestPrompt,
  ToolEditApprovalPrompt,
} from '@eventBus/types';
import type { TodoItem } from '@eventBus/schemas';

// Logger imports
// Type imports

/**
 * Type-safe mapping of commands to their payload types.
 * This enables autocomplete and type checking for the generic send method.
 */
type CommandPayloads = {
  [COMMANDS.UPDATE_STREAMS]: {
    streams: StreamTabInfo[];
    activeStream: StreamTabId;
    agentFilter: AgentTypeFilter;
  };
  [COMMANDS.UPDATE_LOGS]: {
    stream: StreamTabId;
    messages: LogMessageData[];
    groups?: any[];
    runInstructions?: Record<string, InstructionUpdate>;
    activeRunId?: string | null;
    runUsage?: Record<string, TokenUsageStats>;
    runFiles?: Record<string, { [key: number]: OutputFileInfo[] }>;
    forceRebuild?: boolean;
  };
  [COMMANDS.APPEND_LOG]: {
    stream: StreamTabId;
    logMessage: LogMessageData;
  };
  [COMMANDS.UPDATE_LOG]: {
    stream: StreamTabId;
    logMessage: LogMessageData;
  };
  [COMMANDS.UPDATE_FILES]: {
    stream: StreamTabId;
    runId?: string;
    rounds?: { [key: number]: OutputFileInfo[] };
    reset?: boolean;
  };
  [COMMANDS.UPDATE_MISSING_OUTPUTS]: {
    stream: StreamTabId;
    runId?: string;
    rounds?: { [key: number]: string[] };
    reset?: boolean;
  };
  [COMMANDS.SHOW_TOOL_EDIT_APPROVAL]: {
    request: ToolEditApprovalPrompt;
  };
  [COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL]: {
    requestId: string;
  };
  [COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE]: {
    bypassActive: boolean;
  };
  [COMMANDS.SHOW_RETRY_REQUEST]: {
    request: RetryRequestPrompt;
  };
  [COMMANDS.RESOLVE_RETRY_REQUEST]: {
    streamId: string;
  };
  [COMMANDS.UPDATE_USAGE]: {
    stream: StreamTabId;
    usageByRun: Record<string, TokenUsageStats>;
  };
  [COMMANDS.UPDATE_RUN_USAGE]: {
    stream: StreamTabId;
    runId: string;
    usage: TokenUsageStats;
  };
  [COMMANDS.UPDATE_INSTRUCTION]: {
    stream: StreamTabId | '';
    instruction: InstructionUpdate | null;
    sessionKind?: string;
  };
  [COMMANDS.THEME_SET]: {
    theme: 'dark' | 'light';
  };
  [COMMANDS.UPDATE_STATUS]: {
    status: StreamStatus;
  };
  [COMMANDS.UPDATE_STREAM_STATUS]: {
    stream: StreamTabId;
    status: StreamStatus;
    lastTimestamp?: number;
  };
  [COMMANDS.ADD_TASK_GROUP]: {
    stream: StreamTabId;
    group: any;
  };
  [COMMANDS.UPDATE_TASK_GROUP]: {
    update: TaskGroupUpdatePayload;
  };
  [COMMANDS.UPDATE_TODOS]: {
    stream: StreamTabId;
    todos: TodoItem[];
  };
};

/**
 * Manages webview updates for the progress view.
 * Provides a clean interface for updating different parts of the webview
 * without coupling business logic to DOM operations.
 */
export class WebviewUpdater {
  private readonly logger: AgentLogger;

  constructor(private getWebview: () => vscode.Webview | undefined) {
    this.logger = new AgentLogger('WebviewUpdater');
  }

  /** Helper to send messages to webview, eliminating repetitive null checks */
  private sendMessage(message: any): void {
    const webview = this.getWebview();
    if (!webview) return;
    webview.postMessage(message);
  }

  /**
   * Type-safe generic method to send commands to the webview.
   * Provides autocomplete for command names and their required payloads.
   *
   * @example
   * updater.send(COMMANDS.UPDATE_STATUS, { status: 'running' });
   * updater.send(COMMANDS.APPEND_LOG, { stream: 'main', logMessage: msg });
   */
  send<K extends keyof CommandPayloads>(
    command: K,
    payload: CommandPayloads[K],
  ): void {
    this.sendMessage({ command, ...payload });
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
    this.send(COMMANDS.UPDATE_STREAMS, { streams, activeStream, agentFilter });
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
    this.send(COMMANDS.UPDATE_LOGS, {
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
    this.send(COMMANDS.APPEND_LOG, { stream, logMessage });
  }

  /**
   * Update an existing log message
   */
  updateLogMessage(stream: StreamTabId, logMessage: LogMessageData): void {
    this.send(COMMANDS.UPDATE_LOG, { stream, logMessage });
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
    this.send(COMMANDS.UPDATE_FILES, { stream, ...payload });
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
    this.send(COMMANDS.UPDATE_MISSING_OUTPUTS, { stream, ...payload });
  }

  showToolEditApprovalPrompt(prompt: ToolEditApprovalPrompt): void {
    this.send(COMMANDS.SHOW_TOOL_EDIT_APPROVAL, { request: prompt });
  }

  resolveToolEditApprovalPrompt(requestId: string): void {
    this.send(COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL, { requestId });
  }

  updateToolEditApprovalState(bypassActive: boolean): void {
    this.send(COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE, { bypassActive });
  }

  showRetryRequest(request: RetryRequestPrompt): void {
    this.send(COMMANDS.SHOW_RETRY_REQUEST, { request });
  }

  resolveRetryRequest(streamId: string): void {
    this.send(COMMANDS.RESOLVE_RETRY_REQUEST, { streamId });
  }

  /**
   * Update usage statistics (full replacement)
   */
  updateUsage(
    stream: StreamTabId,
    usageByRun: Record<string, TokenUsageStats>,
  ): void {
    this.send(COMMANDS.UPDATE_USAGE, { stream, usageByRun });
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
    this.send(COMMANDS.UPDATE_RUN_USAGE, { stream, runId, usage });
  }

  /**
   * Update instruction panel content
   */
  updateInstruction(
    stream: StreamTabId,
    instruction: InstructionUpdate,
    sessionKind?: string,
  ): void {
    this.send(COMMANDS.UPDATE_INSTRUCTION, { stream, instruction, sessionKind });
  }

  /**
   * Clear instruction panel content
   */
  clearInstruction(stream: StreamTabId | ''): void {
    this.send(COMMANDS.UPDATE_INSTRUCTION, { stream, instruction: null });
  }

  /**
   * Update the code highlight theme
   */
  updateTheme(theme: 'dark' | 'light'): void {
    this.send(COMMANDS.THEME_SET, { theme });
  }

  /**
   * Update stream status indicator (for active stream)
   */
  updateStatus(status: StreamStatus): void {
    this.send(COMMANDS.UPDATE_STATUS, { status });
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
    const payload: CommandPayloads[typeof COMMANDS.UPDATE_STREAM_STATUS] = {
      stream,
      status,
      ...(lastTimestamp !== undefined && { lastTimestamp }),
    };
    this.send(COMMANDS.UPDATE_STREAM_STATUS, payload);
  }

  /**
   * Add a task group to the webview
   */
  addTaskGroup(stream: StreamTabId, group: any): void {
    this.send(COMMANDS.ADD_TASK_GROUP, { stream, group });
  }

  /**
   * Update a task group in the webview
   */
  updateTaskGroup(update: TaskGroupUpdatePayload): void {
    this.send(COMMANDS.UPDATE_TASK_GROUP, { update });
  }

  /**
   * Update the todo list for a stream
   */
  updateTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.send(COMMANDS.UPDATE_TODOS, { stream, todos });
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

    this.logger.debug(
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
