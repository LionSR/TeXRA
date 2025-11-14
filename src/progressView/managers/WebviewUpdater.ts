// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';
// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';

// Internal imports
import { AgentLogger } from '@logger/AgentLogger';
import { LogMessageData } from '@logger/LogTypes';
// Type imports
import type { TaskState } from '@logger/TaskState';
import type {
  InstructionUpdate,
  StreamTabInfo,
  ToolEditApprovalPrompt,
} from '@progressView/types';
// Internal imports
import { buildStreamInfos } from '@progressView/streamInfoUtils';

// Type imports
import type { TaskGroupUpdatePayload } from '@progressView/managers/TaskGroupManager';
// Internal imports
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import { COMMANDS, STATUS } from '@progressView/modules/constants.js';

// Type aliases for status values
type StatusType = (typeof STATUS)[keyof typeof STATUS];

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
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream,
      agentFilter,
    });
  }

  /**
   * Update log content for a specific stream
   */
  updateLogContent(
    stream: StreamTabId,
    messages: LogMessageData[],
    groups: any[] = [],
    extras?: {
      runInstructions?: Record<string, InstructionUpdate>;
      activeRunId?: string | null;
      runFiles?: Record<string, { [key: number]: OutputFileInfo[] }>;
      runMissingOutputs?: Record<string, { [key: number]: string[] }>;
      runUsage?: Record<string, TokenUsageStats>;
    },
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_LOGS,
      stream,
      messages,
      groups,
      runInstructions: extras?.runInstructions,
      activeRunId: extras?.activeRunId,
      runFiles: extras?.runFiles,
      runMissingOutputs: extras?.runMissingOutputs,
      runUsage: extras?.runUsage,
    });
  }

  /**
   * Append a single log message to a stream
   */
  appendLogMessage(stream: StreamTabId, logMessage: LogMessageData): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.APPEND_LOG,
      stream,
      logMessage,
    });
  }

  /**
   * Update an existing log message
   */
  updateLogMessage(stream: StreamTabId, logMessage: LogMessageData): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
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
    filesByRun: Record<string, { [key: number]: OutputFileInfo[] }>,
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_FILES,
      stream,
      filesByRun,
    });
  }

  /**
   * Update missing outputs for a stream
   */
  updateMissingOutputs(
    stream: StreamTabId,
    filesByRun: Record<string, { [key: number]: string[] }>,
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_MISSING_OUTPUTS,
      stream,
      filesByRun,
    });
  }

  showToolEditApprovalPrompt(prompt: ToolEditApprovalPrompt): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.SHOW_TOOL_EDIT_APPROVAL,
      request: prompt,
    });
  }

  resolveToolEditApprovalPrompt(requestId: string): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL,
      requestId,
    });
  }

  updateToolEditApprovalState(bypassActive: boolean): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE,
      bypassActive,
    });
  }

  /**
   * Update usage statistics
   */
  updateUsage(
    stream: StreamTabId,
    usageByRun: Record<string, TokenUsageStats>,
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_USAGE,
      stream,
      usageByRun,
    });
  }

  /**
   * Update instruction panel content
   */
  updateInstruction(
    stream: StreamTabId,
    instruction: InstructionUpdate,
    sessionKind?: string,
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_INSTRUCTION,
      stream,
      instruction,
      sessionKind,
    });
  }

  /**
   * Clear instruction panel content
   */
  clearInstruction(stream: StreamTabId | ''): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_INSTRUCTION,
      stream,
      instruction: null,
    });
  }

  /**
   * Update the code highlight theme
   */
  updateTheme(theme: 'dark' | 'light'): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.THEME_SET,
      theme,
    });
  }

  /**
   * Update stream status
   */
  updateStatus(status: StatusType): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_STATUS,
      status,
    });
  }

  /**
   * Add a task group to the webview
   */
  addTaskGroup(stream: StreamTabId, group: any): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.ADD_TASK_GROUP,
      stream,
      group,
    });
  }

  /**
   * Update a task group in the webview
   */
  updateTaskGroup(update: TaskGroupUpdatePayload): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_TASK_GROUP,
      update,
    });
  }

  /**
   * Update stream metadata and theme for the webview.
   * Returns the resolved active stream after applying the update.
   */
  updateAll(
    state: ProgressViewState,
    statuses?: Map<string, string>,
    theme?: 'dark' | 'light',
  ): StreamTabId {
    const streams = buildStreamInfos(state, statuses, state.agentTypeFilter);

    const webview = this.getWebview();
    let resolvedActiveStream = state.activeStream;
    if (!streams.some((info) => info.name === resolvedActiveStream)) {
      resolvedActiveStream = streams[0]?.name ?? '';
    }

    if (!webview) {
      return resolvedActiveStream;
    }

    if (resolvedActiveStream !== state.activeStream) {
      state.activeStream = resolvedActiveStream;
    }

    if (theme) {
      this.updateTheme(theme);
    }

    this.updateStreams(streams, resolvedActiveStream, state.agentTypeFilter);

    this.logger.debug(
      `Updated webview streams (${streams.length}) active: ${resolvedActiveStream}`,
    );

    return resolvedActiveStream;
  }

  /**
   * Check if webview is available
   */
  isAvailable(): boolean {
    return this.getWebview() !== undefined;
  }
}
