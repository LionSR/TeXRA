// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { WebviewUpdater } from '../managers';

import { STATUS } from '../modules/constants.js';

// Local imports
import { ProgressViewState } from '../state/ProgressViewState';
import { buildStreamInfos } from '../streamInfoUtils';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';
import type { TokenUsageStats } from '@agent/types/UsageTypes';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';

// Types
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import {
  createStreamStatusEvents,
  type StreamStatusEventModule,
} from './StreamStatusEvents';
import { createOutputEvents, type OutputEventsModule } from './OutputEvents';
import { createUsageEvents, type UsageEventsModule } from './UsageEvents';
import { createLogEvents, type LogEventsModule } from './LogEvents';
import {
  createTaskGroupEvents,
  type TaskGroupEventsModule,
} from './TaskGroupEvents';

// Local imports - events
import type {
  StatusType,
  StreamStatusOrReadyType,
  StreamStatusType,
} from './types';

/**
 * Handles progress event bus subscriptions for the progress view.
 * Provides a clean separation between event handling and business logic
 * by delegating to the state manager and webview updater.
 */
export class ProgressEventHandler {
  private readonly logger: AgentLogger;
  private _streamStatus: Map<string, StreamStatusType> = new Map();
  private readonly streamStatusEvents: StreamStatusEventModule;
  private readonly outputEvents: OutputEventsModule;
  private readonly logEvents: LogEventsModule;
  private readonly usageEvents: UsageEventsModule;
  private readonly taskGroupEvents: TaskGroupEventsModule;

  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater,
  ) {
    this.logger = new AgentLogger('ProgressEventHandler');
    this.streamStatusEvents = createStreamStatusEvents({
      logger: this.logger,
      streamStatus: this._streamStatus,
      setStreamStatus: (stream, status) => this.setStreamStatus(stream, status),
      sendInstructionUpdate: (stream) => this.sendInstructionUpdate(stream),
      refreshStreamSurface: (stream, options) =>
        this.refreshStreamSurface(stream, options),
    });
    this.outputEvents = createOutputEvents({
      logger: this.logger,
    });
    this.usageEvents = createUsageEvents({
      logger: this.logger,
    });
    this.logEvents = createLogEvents({
      logger: this.logger,
    });
    this.taskGroupEvents = createTaskGroupEvents({
      logger: this.logger,
      initializeStreamForTaskGroup: (stream) =>
        this.initializeStreamForTaskGroup(stream),
    });
  }

  /**
   * Setup all event bus listeners
   */
  setupEventListeners(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    disposables.push(
      ...this.streamStatusEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.outputEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.usageEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.logEvents.register(bus, this.state, this.webviewUpdater),
    );
    disposables.push(
      ...this.taskGroupEvents.register(bus, this.state, this.webviewUpdater),
    );
    return disposables;
  }

  /**
   * Send instruction updates for the provided stream
   */
  private sendInstructionUpdate(stream: StreamTabId | ''): void {
    if (!this.webviewUpdater.isAvailable()) {
      return;
    }

    if (!stream) {
      this.webviewUpdater.clearInstruction('');
      return;
    }

    const taskState = this.state.getTaskState(stream);
    const instructionUpdate = WebviewUpdater.createInstructionUpdate(taskState);
    const sessionKindHint = this.state.getSessionKindHint(stream);
    const sessionKind = taskState?.session?.agentCategory ?? sessionKindHint;
    const runId = this.state.resolveRunId(stream, undefined, {
      persist: false,
    });

    if (runId && instructionUpdate) {
      void this.state.runInstructions.setInstruction(
        stream,
        runId,
        instructionUpdate,
      );
    } else if (runId) {
      void this.state.runInstructions.deleteRun(stream, runId);
    }

    if (instructionUpdate) {
      this.webviewUpdater.updateInstruction(
        stream,
        instructionUpdate,
        sessionKind,
      );
    } else {
      this.webviewUpdater.clearInstruction(stream);
    }
  }

  /**
   * Refresh all webview surface data for a specific stream.
   */
  public refreshStreamSurface(
    stream: string,
    options: { updateInstruction?: boolean } = {},
  ): void {
    if (!this.webviewUpdater.isAvailable()) return;

    const { updateInstruction = true } = options;

    const messages = this.state.streamTabs.getMessages(stream);
    const groups = Array.from(
      this.state.taskGroups.getStreamGroups(stream).values(),
    );
    const activeRunId = this.state.resolveRunId(stream, undefined, {
      persist: false,
    });

    const runInstructions = Object.fromEntries(
      this.state.runInstructions.getInstructions(stream).entries(),
    );

    const filesByRun = this.formatRunOutputs(
      this.state.outputFiles.getFiles(stream),
    );
    const missingByRun = this.formatRunStringOutputs(
      this.state.outputFiles.getMissingOutputs(stream),
    );
    const usageByRun = Object.fromEntries(
      this.state.usageStats.getRunUsage(stream).entries(),
    ) as Record<string, TokenUsageStats>;

    this.webviewUpdater.updateLogContent(stream, messages, groups, {
      runInstructions,
      activeRunId,
      runFiles: filesByRun,
      runMissingOutputs: missingByRun,
      runUsage: usageByRun,
    });

    // Send output files for current stream
    this.webviewUpdater.updateFiles(stream, filesByRun);

    // Send missing outputs for current stream
    this.webviewUpdater.updateMissingOutputs(stream, missingByRun);

    // Send usage for current stream
    const usage = Object.fromEntries(
      this.state.usageStats.getRunUsage(stream).entries(),
    ) as Record<string, TokenUsageStats>;
    this.webviewUpdater.updateUsage(stream, usage);

    // Update status for current stream - default to STOPPED when stream exists but no status is set
    const status = this._streamStatus.get(stream) || STATUS.STOPPED;
    this.webviewUpdater.updateStatus(status);

    if (updateInstruction) {
      this.sendInstructionUpdate(stream);
    }
  }

  /**
   * Get current stream status
   */
  getStreamStatus(stream: string): StreamStatusType | undefined {
    return this._streamStatus.get(stream);
  }

  /**
   * Set the status for a specific stream synchronously.
   */
  setStreamStatus(stream: string, status: StreamStatusOrReadyType): void {
    if (status === STATUS.READY) {
      this._streamStatus.delete(stream);
    } else {
      const nextStatus: StreamStatusType = status;
      this._streamStatus.set(stream, nextStatus);
    }

    if (this.webviewUpdater.isAvailable()) {
      const infos = buildStreamInfos(
        this.state,
        this._streamStatus,
        this.state.agentTypeFilter,
      );
      this.webviewUpdater.updateStreams(
        infos,
        this.state.activeStream,
        this.state.agentTypeFilter,
      );

      if (stream === this.state.activeStream) {
        this.webviewUpdater.updateStatus(status);
      }
    }
  }

  private formatRunOutputs(
    runs: Map<string, Map<number, OutputFileInfo[]>>,
  ): Record<string, { [key: number]: OutputFileInfo[] }> {
    const payload: Record<string, { [key: number]: OutputFileInfo[] }> = {};
    for (const [runId, rounds] of runs.entries()) {
      payload[runId] = Object.fromEntries(rounds.entries());
    }
    return payload;
  }

  private formatRunStringOutputs(
    runs: Map<string, Map<number, string[]>>,
  ): Record<string, { [key: number]: string[] }> {
    const payload: Record<string, { [key: number]: string[] }> = {};
    for (const [runId, rounds] of runs.entries()) {
      payload[runId] = Object.fromEntries(rounds.entries());
    }
    return payload;
  }

  /**
   * Get a copy of all stream statuses
   */
  getAllStreamStatuses(): Map<string, StreamStatusType> {
    return new Map(this._streamStatus);
  }

  /**
   * Initialize a stream when task group events arrive before dedicated
   * status or activation events, preserving any existing status metadata.
   */
  private async initializeStreamForTaskGroup(stream: string): Promise<void> {
    const existingStatus = this._streamStatus.get(stream);

    await this.state.streamTabs.ensureStream(stream);

    if (!existingStatus) {
      this.setStreamStatus(stream, STATUS.RUNNING);
    }

    this.state.setSessionKindHint(stream, AgentCategory.Workflow);

    const currentFilter = this.state.agentTypeFilter;
    if (currentFilter !== 'all' && currentFilter !== AgentCategory.Workflow) {
      this.state.agentTypeFilter = AgentCategory.Workflow;
    }

    this.state.activeStream = stream;

    const status = this._streamStatus.get(stream) ?? STATUS.RUNNING;
    this.setStreamStatus(stream, status);

    if (this.webviewUpdater.isAvailable()) {
      this.refreshStreamSurface(stream, { updateInstruction: false });
      this.sendInstructionUpdate(stream);
    }
  }

  /**
   * Mark all running tasks as cancelled (used during restart)
   */
  markAllRunningTasksAsCancelled(): void {
    for (const [stream, status] of this._streamStatus.entries()) {
      if (status === STATUS.RUNNING) {
        this._streamStatus.set(stream, STATUS.STOPPED);
      }
    }
  }

  /**
   * Reset running tasks to ERROR status (used during webview reload)
   * Returns the list of affected streams for further processing
   */
  resetRunningTasksToError(waitingStreams?: Set<string>): string[] {
    const affectedStreams: string[] = [];
    const waitingSet = waitingStreams ?? new Set<string>();

    for (const [stream, status] of this._streamStatus.entries()) {
      if (status === STATUS.RUNNING) {
        if (waitingSet.has(stream)) {
          this._streamStatus.set(stream, STATUS.WAITING);
          this.logger.debug(
            `Stream ${stream} restored to WAITING after reload`,
          );
        } else {
          this._streamStatus.set(stream, STATUS.ERROR);
          affectedStreams.push(stream);
          this.logger.debug(
            `Stream ${stream} set to ERROR due to webview reload`,
          );
        }
      }
    }

    return affectedStreams;
  }
}
