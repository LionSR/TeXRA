// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view

import { COMMANDS, STATUS } from '../modules/constants.js';

// Local imports
import { ProgressViewState } from '../state/ProgressViewState';
import { buildStreamInfos } from '../streamInfoUtils';
import type { InstructionUpdate, StreamTabInfo } from '../types';
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';

// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { AgentLogger } from '@logger/AgentLogger';
import { LogMessageData } from '@logger/LogTypes';
import type { TaskState } from '@logger/TaskState';

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
    groups?: any[],
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_LOGS,
      stream,
      messages,
      groups: groups || [],
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
    files: { [key: number]: OutputFileInfo[] },
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_FILES,
      stream,
      files,
    });
  }

  /**
   * Update missing outputs for a stream
   */
  updateMissingOutputs(
    stream: StreamTabId,
    files: { [key: number]: string[] },
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_MISSING_OUTPUTS,
      stream,
      files,
    });
  }

  /**
   * Update usage statistics
   */
  updateUsage(usage?: TokenUsageStats): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_USAGE,
      usage,
    });
  }

  /**
   * Update instruction panel content
   */
  updateInstruction(stream: StreamTabId, instruction: InstructionUpdate): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_INSTRUCTION,
      stream,
      instruction,
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
  updateTaskGroup(
    stream: StreamTabId,
    groupId: string,
    status: StatusType,
    endTime?: number,
  ): void {
    const webview = this.getWebview();
    if (!webview) return;

    webview.postMessage({
      command: COMMANDS.UPDATE_TASK_GROUP,
      stream,
      groupId,
      status,
      endTime,
    });
  }

  /**
   * Update all webview content based on current state
   */
  updateAll(state: ProgressViewState, statuses?: Map<string, string>): void {
    const webview = this.getWebview();
    if (!webview) return;

    const streams = buildStreamInfos(state, statuses, state.agentTypeFilter);

    let activeStream = state.activeStream;
    if (!streams.some((info) => info.name === activeStream)) {
      activeStream = streams[0]?.name ?? '';
      state.activeStream = activeStream;
    }

    // Update streams and active stream
    this.updateStreams(streams, activeStream, state.agentTypeFilter);

    if (activeStream) {
      // Update log content for active stream
      const messages = state.streamTabs.get(activeStream) || [];
      const groups = Array.from(
        state.taskGroups.getStreamGroups(activeStream).values(),
      );
      this.updateLogContent(activeStream, messages, groups);

      // Update files for active stream
      const files = state.outputFiles.getFiles(activeStream) || {};
      this.updateFiles(activeStream, files);

      // Update missing outputs for active stream
      const missing = state.outputFiles.getMissingOutputs(activeStream) || {};
      this.updateMissingOutputs(activeStream, missing);

      // Update usage for active stream
      const usage = state.usageStats.getStreamUsage(activeStream);
      this.updateUsage(usage);

      const taskState = state.getTaskState(activeStream);
      const instructionUpdate =
        WebviewUpdater.createInstructionUpdate(taskState);
      if (instructionUpdate) {
        this.updateInstruction(activeStream, instructionUpdate);
      } else {
        this.clearInstruction(activeStream);
      }
    } else {
      // Clear content when no active stream
      this.updateLogContent('', [], []);
      this.updateFiles('', {});
      this.updateMissingOutputs('', {});
      this.updateUsage(undefined);
      this.clearInstruction('');
    }

    this.logger.debug(
      `Updated webview with ${streams.length} streams, active: ${activeStream}`,
    );
  }

  /**
   * Check if webview is available
   */
  isAvailable(): boolean {
    return this.getWebview() !== undefined;
  }
}
