import { basename } from 'node:path';

import {
  prepareMainViewExecutionRequest,
  type MainViewExecuteMessage,
} from '@controllers/mainView/MainViewExecutionController';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { setRunStorageService } from '@agent/runtime/RunStorageService';
import { runValidatedExecutionRequest } from '@agent/runtime/runExecutionRequest';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';
import {
  STREAM_STATUS,
  type ActiveChildInfo,
  type AgentCategory,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ProgressViewOutboundMessage,
  type StreamMetadata,
  type StreamStatus,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { AGENT_CATEGORY } from '@shared/schemas/agent';

import { DESKTOP_SHELL_COMMANDS } from '../desktopShellMessages.js';

export interface DesktopAgentExecutionOptions {
  postToRenderer(message: unknown): void;
  openPath?: (filePath: string) => Promise<void>;
  showErrorMessage?: (message: string) => Promise<void> | void;
}

export interface DesktopAgentExecution {
  handleExecute(message: MainViewExecuteMessage): Promise<void>;
  progress: DesktopProgressBridge;
  dispose(): void;
}

type TaskState = ProgressEventPayloads['setTaskState']['taskState'];

type StreamBadgeSnapshot = {
  activeSubagents: ActiveChildInfo[];
  finishedSubagentCount: number;
  activeProcesses: ActiveChildInfo[];
  finishedProcessCount: number;
};

export class DesktopProgressBridge {
  private readonly streamLogs = new StreamLogStore();
  private readonly cursors = new Map<StreamTabId, number>();
  private readonly taskStates = new Map<StreamTabId, TaskState>();
  private readonly statuses = new Map<StreamTabId, StreamStatus>();
  private readonly categories = new Map<StreamTabId, AgentCategory>();
  private readonly executionIds = new Map<StreamTabId, string>();
  private readonly descriptions = new Map<StreamTabId, string>();
  private readonly parentStreams = new Map<StreamTabId, StreamTabId>();
  private readonly creationTimestamps = new Map<StreamTabId, number>();
  private readonly conversationProgress = new Map<
    StreamTabId,
    ConversationProgress
  >();
  private readonly streamBadges = new Map<StreamTabId, StreamBadgeSnapshot>();
  private activeStream: StreamTabId | '' = '';
  private agentFilter: AgentCategoryFilter = 'all';
  private readonly unsubscribe: () => void;

  readonly runtimeHost: AgentRuntimeHost;

  constructor(private readonly postToRenderer: (message: unknown) => void) {
    AgentLogger.setStreamLogStore(this.streamLogs);
    setRunStorageService({ isViewVisible: () => true });
    this.unsubscribe = this.streamLogs.onChange((streamId) =>
      this.flushLogs(streamId),
    );
    this.runtimeHost = {
      emit: (event, payload) => this.handleProgressEvent(event, payload),
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.cursors.clear();
    this.taskStates.clear();
    this.statuses.clear();
    this.categories.clear();
    this.executionIds.clear();
    this.descriptions.clear();
    this.parentStreams.clear();
    this.creationTimestamps.clear();
    this.conversationProgress.clear();
    this.streamBadges.clear();
  }

  private send(message: ProgressViewOutboundMessage): void {
    this.postToRenderer(message);
  }

  private routeToProgress(): void {
    this.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route: 'progress',
    });
  }

  private ensureStream(
    streamId: StreamTabId,
    category: AgentCategory = AGENT_CATEGORY.WORKFLOW,
  ): void {
    this.getCreationTimestamp(streamId);
    this.streamLogs.ensureStream(streamId);
    if (!this.categories.has(streamId)) {
      this.categories.set(streamId, category);
    }
  }

  private getCreationTimestamp(streamId: StreamTabId): number {
    const existing = this.creationTimestamps.get(streamId);
    if (existing != null) return existing;
    const createdAt = this.streamLogs.getFirstTimestamp(streamId) ?? Date.now();
    this.creationTimestamps.set(streamId, createdAt);
    return createdAt;
  }

  private buildStreamInfo(streamId: StreamTabId): StreamTabInfo {
    const taskState = this.taskStates.get(streamId);
    const config = taskState?.agentConfig;
    const category =
      config?.agentCategory ??
      this.categories.get(streamId) ??
      AGENT_CATEGORY.WORKFLOW;
    const inputFile = config?.inputFile ?? '';
    const agentName = config?.agent ?? streamId.split('@')[0] ?? streamId;
    return {
      name: streamId,
      label:
        category !== AGENT_CATEGORY.TOOL_USE && inputFile
          ? `${agentName}: ${basename(inputFile)}`
          : agentName,
      model: config?.model,
      modelLabel: config?.model,
      agent: config?.agent,
      agentCategory: category,
      hasMultipleOutputs: config?.useMultipleOutputs ?? false,
      inputFile,
      creationTimestamp: this.getCreationTimestamp(streamId),
      executionId: this.executionIds.get(streamId),
      parentStreamId: this.parentStreams.get(streamId),
      description: this.descriptions.get(streamId),
    };
  }

  private buildStreamMetadata(streamId: StreamTabId): StreamMetadata {
    const category =
      this.taskStates.get(streamId)?.agentConfig.agentCategory ??
      this.categories.get(streamId) ??
      AGENT_CATEGORY.WORKFLOW;
    return {
      kind: category,
      status: this.statuses.get(streamId) ?? STREAM_STATUS.READY,
      lastTimestamp: this.streamLogs.getLastTimestamp(streamId),
      conversationProgress: this.conversationProgress.get(streamId) ?? {
        conversationTurns: 0,
        toolCallCount: 0,
      },
      activeSubagents: this.streamBadges.get(streamId)?.activeSubagents ?? [],
      finishedSubagentCount:
        this.streamBadges.get(streamId)?.finishedSubagentCount ?? 0,
      activeProcesses: this.streamBadges.get(streamId)?.activeProcesses ?? [],
      finishedProcessCount:
        this.streamBadges.get(streamId)?.finishedProcessCount ?? 0,
    };
  }

  private updateActiveChildren(
    parentStreamId: StreamTabId,
    opts: {
      activeField: 'activeSubagents' | 'activeProcesses';
      countField: 'finishedSubagentCount' | 'finishedProcessCount';
      next: ActiveChildInfo[];
    },
  ): StreamBadgeSnapshot {
    this.ensureStream(parentStreamId);
    const previous = this.streamBadges.get(parentStreamId) ?? {
      activeSubagents: [],
      finishedSubagentCount: 0,
      activeProcesses: [],
      finishedProcessCount: 0,
    };
    const previousIds = new Set(
      previous[opts.activeField].map((child) => child.executionId),
    );
    const nextIds = new Set(opts.next.map((child) => child.executionId));
    const newlyFinished = [...previousIds].filter(
      (id) => !nextIds.has(id),
    ).length;
    const nextBadges = {
      ...previous,
      [opts.activeField]: opts.next,
      [opts.countField]: previous[opts.countField] + newlyFinished,
    };
    this.streamBadges.set(parentStreamId, nextBadges);
    return nextBadges;
  }

  private syncStreams(): void {
    const streams = this.streamLogs
      .keys()
      .map((id) => this.buildStreamInfo(id));
    const streamStates = Object.fromEntries(
      streams.map((stream) => [
        stream.name,
        this.buildStreamMetadata(stream.name),
      ]),
    );
    this.send({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams,
      activeStream: this.activeStream,
      agentFilter: this.agentFilter,
      streamStates,
    });
  }

  private flushLogs(streamId: StreamTabId): void {
    if (streamId !== this.activeStream) return;
    const log = this.streamLogs.get(streamId);
    if (!log) return;
    const cursor = this.cursors.get(streamId) ?? 0;
    const entries = log.getRange(cursor, log.head);
    const updates = log.drainDirtyUpdates(cursor);
    if (entries.length === 0 && updates.length === 0) return;
    this.send({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId,
      entries,
      updates,
    });
    this.cursors.set(streamId, log.head);
  }

  private handleProgressEvent<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    switch (event) {
      case 'requestEnsureProgressView':
        this.routeToProgress();
        break;
      case 'setActiveStream': {
        const data = payload as ProgressEventPayloads['setActiveStream'];
        if (!data.streamId) {
          this.activeStream = '';
          this.send({
            command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
            activeStream: '',
          });
          break;
        }
        this.ensureStream(
          data.streamId,
          data.agentCategory ?? AGENT_CATEGORY.WORKFLOW,
        );
        this.activeStream = data.streamId;
        this.routeToProgress();
        this.syncStreams();
        this.send({
          command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
          activeStream: data.streamId,
        });
        this.flushLogs(data.streamId);
        break;
      }
      case 'setTaskState': {
        const data = payload as ProgressEventPayloads['setTaskState'];
        this.ensureStream(
          data.streamId,
          data.taskState.agentConfig.agentCategory,
        );
        this.taskStates.set(data.streamId, data.taskState);
        if (data.executionId)
          this.executionIds.set(data.streamId, data.executionId);
        this.syncStreams();
        break;
      }
      case 'updateStreamStatus': {
        const data = payload as ProgressEventPayloads['updateStreamStatus'];
        const wasKnownStream = this.streamLogs.has(data.streamId);
        this.ensureStream(data.streamId);
        this.statuses.set(data.streamId, data.status);
        if (!wasKnownStream) {
          this.syncStreams();
        }
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
          stream: data.streamId,
          status: data.status,
          lastTimestamp: this.streamLogs.getLastTimestamp(data.streamId),
        });
        break;
      }
      case 'updateConversationProgress': {
        const data =
          payload as ProgressEventPayloads['updateConversationProgress'];
        this.conversationProgress.set(data.streamId, data.progress);
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS,
          stream: data.streamId,
          progress: data.progress,
        });
        break;
      }
      case 'updateTodos': {
        const data = payload as ProgressEventPayloads['updateTodos'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
          stream: data.streamId,
          todos: data.todos,
        });
        break;
      }
      case 'updatePlan': {
        const data = payload as ProgressEventPayloads['updatePlan'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PLAN,
          stream: data.streamId,
          plan: data.plan,
        });
        break;
      }
      case 'updateStreamUsage': {
        const data = payload as ProgressEventPayloads['updateStreamUsage'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE,
          stream: data.streamId,
          runId: data.executionId ?? data.storageKey,
          usage: data.usage,
        });
        break;
      }
      case 'addOutputFiles': {
        const data = payload as ProgressEventPayloads['addOutputFiles'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
          stream: data.streamId,
          rounds: data.filesByRound,
        });
        break;
      }
      case 'updateMissingOutputs': {
        const data = payload as ProgressEventPayloads['updateMissingOutputs'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
          stream: data.streamId,
          rounds: data.filesByRound,
        });
        break;
      }
      case 'updateCompileFailures': {
        const data = payload as ProgressEventPayloads['updateCompileFailures'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
          stream: data.streamId,
          rounds: data.filesByRound,
          reset: true,
        });
        break;
      }
      case 'updateStreamDescription': {
        const data =
          payload as ProgressEventPayloads['updateStreamDescription'];
        this.descriptions.set(data.streamId, data.description);
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION,
          stream: data.streamId,
          description: data.description,
        });
        break;
      }
      case 'setParentStream': {
        const data = payload as ProgressEventPayloads['setParentStream'];
        this.parentStreams.set(data.childStreamId, data.parentStreamId);
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM,
          stream: data.childStreamId,
          parentStreamId: data.parentStreamId,
        });
        break;
      }
      case 'updateActiveSubagents':
      case 'updateActiveProcesses': {
        const data = payload as
          | ProgressEventPayloads['updateActiveSubagents']
          | ProgressEventPayloads['updateActiveProcesses'];
        const badges =
          event === 'updateActiveSubagents'
            ? this.updateActiveChildren(data.parentStreamId, {
                activeField: 'activeSubagents',
                countField: 'finishedSubagentCount',
                next: (data as ProgressEventPayloads['updateActiveSubagents'])
                  .children,
              })
            : this.updateActiveChildren(data.parentStreamId, {
                activeField: 'activeProcesses',
                countField: 'finishedProcessCount',
                next: (data as ProgressEventPayloads['updateActiveProcesses'])
                  .processes,
              });
        this.syncStreams();
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
          stream: data.parentStreamId,
          ...badges,
        });
        break;
      }
      case 'updateProcessOutput': {
        const data = payload as ProgressEventPayloads['updateProcessOutput'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT,
          stream: data.parentStreamId,
          executionId: data.executionId,
          stdout: data.stdout,
          stderr: data.stderr,
        });
        break;
      }
    }
  }

  syncFullView(): void {
    this.syncStreams();
    if (this.activeStream) this.flushLogs(this.activeStream);
  }

  setActiveStream(streamId: StreamTabId): void {
    this.ensureStream(streamId);
    this.activeStream = streamId;
    this.syncStreams();
    this.send({
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: streamId,
    });
    this.flushLogs(streamId);
  }

  setAgentFilter(filter: AgentCategoryFilter): void {
    this.agentFilter = filter;
    this.syncStreams();
  }

  async deleteStream(streamId: StreamTabId): Promise<void> {
    const hadStream =
      this.streamLogs.has(streamId) || this.taskStates.has(streamId);
    if (!hadStream) return;

    const wasActive = this.activeStream === streamId;
    await this.streamLogs.delete(streamId);
    this.taskStates.delete(streamId);
    this.statuses.delete(streamId);
    this.categories.delete(streamId);
    this.executionIds.delete(streamId);
    this.descriptions.delete(streamId);
    this.parentStreams.delete(streamId);
    this.creationTimestamps.delete(streamId);
    this.conversationProgress.delete(streamId);
    this.streamBadges.delete(streamId);
    this.cursors.delete(streamId);

    if (wasActive) {
      this.activeStream = this.streamLogs.keys()[0] ?? '';
    }
    this.send({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: streamId,
    });
    this.syncStreams();
    if (wasActive && this.activeStream) {
      this.send({
        command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        activeStream: this.activeStream,
      });
      this.flushLogs(this.activeStream);
    }
  }

  async deleteAllStreams(): Promise<void> {
    await this.streamLogs.clear();
    this.cursors.clear();
    this.taskStates.clear();
    this.statuses.clear();
    this.categories.clear();
    this.executionIds.clear();
    this.descriptions.clear();
    this.parentStreams.clear();
    this.creationTimestamps.clear();
    this.conversationProgress.clear();
    this.streamBadges.clear();
    this.activeStream = '';
    this.send({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL });
    this.syncStreams();
  }
}

export function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): DesktopAgentExecution {
  const progress = new DesktopProgressBridge(options.postToRenderer);

  return {
    progress,
    async handleExecute(message) {
      const preparation = prepareMainViewExecutionRequest(message);
      if (!preparation.valid) {
        await options.showErrorMessage?.(preparation.message);
        return;
      }

      await runValidatedExecutionRequest(preparation.request, {
        runtimeHost: progress.runtimeHost,
        openWorkflowOutput: async (result) => {
          const output = result.outputs.at(-1);
          if (output && options.openPath) {
            await options.openPath(output.absolutePath);
          }
        },
      });
    },
    dispose() {
      progress.dispose();
    },
  };
}
