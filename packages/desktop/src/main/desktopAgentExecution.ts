import path, { basename } from 'node:path';

import {
  prepareMainViewExecutionRequest,
  type MainViewExecuteMessage,
} from '@controllers/mainView/MainViewExecutionController';
import type { ValidatedExecutionRequest } from '@agent/core/executionRequests';
import { proposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { planApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  detachActiveChildren,
  interruptActiveChildren,
} from '@agent/runtime/executionRegistry';
import { setRunStorageService } from '@agent/runtime/RunStorageService';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { ExternalOpener } from '@hosts/externalOpener';
import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';
import {
  STREAM_STATUS,
  type ActiveChildInfo,
  type AgentCategory,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ProgressViewInboundMessage,
  type ProgressViewOutboundMessage,
  type StreamMetadata,
  type StreamStatus,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { AGENT_CATEGORY } from '@shared/schemas/agent';
import {
  cleanupAllApprovals,
  cleanupApprovalsForStream,
  handleProgressViewBashApprovalAction,
} from '@tools/approval';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import { toolEditApprovalController } from '@tools/approval/toolEditApproval';
import {
  createExternalLocation,
  pathToLocation,
  type FileLocation,
} from '@utils/files';

import { DESKTOP_SHELL_COMMANDS } from '../desktopShellMessages.js';

export interface DesktopAgentExecutionOptions {
  postToRenderer(message: unknown): void;
  opener?: Pick<ExternalOpener, 'openPath'> & {
    openBuildDisplay?: BuildDisplayFn;
  };
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

export interface DesktopProgressBridgeOptions {
  detachSubagentsOnStop?: boolean;
  openPath?: (filePath: string) => Promise<void>;
  openBuildDisplay?: BuildDisplayFn;
  showMessage?: (message: string) => Promise<void>;
}

function toFileLocation(filePath: string): FileLocation {
  return path.isAbsolute(filePath)
    ? createExternalLocation(filePath)
    : pathToLocation(filePath);
}

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

  constructor(
    private readonly postToRenderer: (message: unknown) => void,
    private readonly options: DesktopProgressBridgeOptions = {},
  ) {
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
      case 'showToolEditPermission': {
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'show',
          permission: {
            kind: 'toolEdit',
            data: payload as ProgressEventPayloads['showToolEditPermission'],
          },
        });
        break;
      }
      case 'resolveToolEditPermission': {
        const data =
          payload as ProgressEventPayloads['resolveToolEditPermission'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'resolve',
          kind: 'toolEdit',
          id: data.requestId,
        });
        break;
      }
      case 'updateToolEditApprovalBypassState': {
        const data =
          payload as ProgressEventPayloads['updateToolEditApprovalBypassState'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS,
          stream: data.streamId,
          type: 'toolEdit',
          bypassActive: data.bypassActive,
        });
        break;
      }
      case 'showBashPermission': {
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'show',
          permission: {
            kind: 'bash',
            data: payload as ProgressEventPayloads['showBashPermission'],
          },
        });
        break;
      }
      case 'resolveBashPermission': {
        const data = payload as ProgressEventPayloads['resolveBashPermission'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'resolve',
          kind: 'bash',
          id: data.requestId,
        });
        break;
      }
      case 'showAgentProposal': {
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'show',
          permission: {
            kind: 'proposal',
            data: payload as ProgressEventPayloads['showAgentProposal'],
          },
        });
        break;
      }
      case 'resolveAgentProposal': {
        const data = payload as ProgressEventPayloads['resolveAgentProposal'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'resolve',
          kind: 'proposal',
          id: data.proposalId,
        });
        break;
      }
      case 'showPlanApproval': {
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'show',
          permission: {
            kind: 'planApproval',
            data: payload as ProgressEventPayloads['showPlanApproval'],
          },
        });
        break;
      }
      case 'resolvePlanApproval': {
        const data = payload as ProgressEventPayloads['resolvePlanApproval'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'resolve',
          kind: 'planApproval',
          id: data.approvalId,
        });
        break;
      }
      case 'updateSuperYoloBypassState': {
        const data =
          payload as ProgressEventPayloads['updateSuperYoloBypassState'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS,
          stream: data.streamId,
          type: 'superYolo',
          bypassActive: data.bypassActive,
        });
        break;
      }
      case 'updateQueuedFollowUps': {
        const data = payload as ProgressEventPayloads['updateQueuedFollowUps'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS,
          stream: data.streamId,
          messages: ToolUseFollowUpQueue.getAll(data.streamId),
        });
        break;
      }
      case 'clearMissingOutputs':
      case 'showRetryRequest':
      case 'resolveRetryRequest':
      case 'showExternalInquiry':
      case 'resolveExternalInquiry':
      case 'followUpSent':
      case 'removeStream':
      case 'extensionDeactivating':
      case 'githubTokenInvalid':
      case 'prSubscriptionsChanged':
      case 'prSubscriptionBindingsChanged':
      case 'repoSubscriptionsChanged':
      case 'repoSubscriptionBindingsChanged':
      case 'issueSubscriptionsChanged':
      case 'issueSubscriptionBindingsChanged':
      case 'toolAvailabilityChanged':
      case 'workspaceFilesWritten':
      case 'requestOpenFile':
      case 'requestShowInstruction':
      case 'showAgentConfigBanner':
      case 'requestShowError':
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  syncFullView(): void {
    this.syncStreams();
    if (this.activeStream) this.flushLogs(this.activeStream);
  }

  setActiveStream(streamId: StreamTabId): void {
    if (!this.streamLogs.has(streamId) && !this.taskStates.has(streamId)) {
      return;
    }
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

    cleanupApprovalsForStream(streamId);
    retryCoordinator.clearRequest(streamId);
    ToolUseFollowUpQueue.release(streamId);

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

    const shouldSelectFallback = this.activeStream === streamId;
    if (shouldSelectFallback) {
      this.activeStream = this.streamLogs.keys()[0] ?? '';
    }
    this.send({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: streamId,
    });
    this.syncStreams();
    if (shouldSelectFallback && this.activeStream) {
      this.send({
        command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        activeStream: this.activeStream,
      });
      this.flushLogs(this.activeStream);
    }
  }

  async deleteAllStreams(): Promise<void> {
    cleanupAllApprovals();
    for (const streamId of this.streamLogs.keys()) {
      retryCoordinator.clearRequest(streamId);
      ToolUseFollowUpQueue.release(streamId);
    }

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

  stopStream(streamId: StreamTabId): void {
    retryCoordinator.clearRequest(streamId);
    if (this.options.detachSubagentsOnStop === true) {
      detachActiveChildren(streamId);
    } else {
      interruptActiveChildren(streamId);
    }
    getInterruptible(streamId)?.interrupt();
    StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, {
      runtimeHost: this.runtimeHost,
    });
  }

  async resumeStream(streamId: StreamTabId): Promise<void> {
    const taskState = this.taskStates.get(streamId);
    if (!taskState) return;

    const executionId = this.executionIds.get(streamId);
    await this.runExecution({
      config: taskState.agentConfig,
      ...(executionId && { executionId }),
    });
  }

  async runNewStream(streamId: StreamTabId): Promise<void> {
    const taskState = this.taskStates.get(streamId);
    if (!taskState) return;

    await this.runExecution({ config: taskState.agentConfig });
  }

  async sendFollowUp(streamId: StreamTabId, text: string): Promise<void> {
    const result = await sendFollowUp(streamId, text);
    if (result.status === 'sent' || result.status === 'queued') {
      this.runtimeHost.emit('updateQueuedFollowUps', { streamId });
      return;
    }

    await this.options.showMessage?.(
      'No active session. Start a new agent task to continue.',
    );
  }

  async openFile(filePath: string): Promise<void> {
    await this.options.openPath?.(filePath);
  }

  async openFileCompile(filePath: string): Promise<void> {
    if (this.options.openBuildDisplay) {
      await this.options.openBuildDisplay(toFileLocation(filePath));
      return;
    }
    await this.openFile(filePath);
  }

  async handleBashApprovalAction(
    message: Extract<
      ProgressViewInboundMessage,
      { command: typeof PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION }
    >,
  ): Promise<void> {
    await handleProgressViewBashApprovalAction(message);
  }

  handleToolEditApprovalAction(
    message: Extract<
      ProgressViewInboundMessage,
      { command: typeof PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION }
    >,
  ): boolean {
    if (message.action !== 'approve' && message.action !== 'reject') {
      return false;
    }

    const entry = toolEditApprovalController.getPending(message.requestId);
    if (!entry || entry.isSettled()) return true;
    entry.settle({
      accepted: message.action === 'approve',
      userMessage:
        message.action === 'reject' ? message.feedback?.trim() : undefined,
    });
    return true;
  }

  handlePlanApprovalAction(
    message: Extract<
      ProgressViewInboundMessage,
      { command: typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION }
    >,
  ): void {
    planApprovalCoordinator.resolveRequest(message.approvalId, {
      action: message.action,
      ...(message.action === 'reject' && { feedback: message.feedback }),
    });
  }

  handleAgentProposalAction(
    message: Extract<
      ProgressViewInboundMessage,
      { command: typeof PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION }
    >,
  ): boolean {
    if (message.action === 'setup') return false;

    proposalCoordinator.resolveRequest(message.proposalId, {
      action: message.action,
      ...(message.action === 'approve' && {
        model: message.model,
        agent: message.agent,
      }),
      ...(message.action === 'reject' && { feedback: message.feedback }),
    });
    return true;
  }

  async runExecution(request: ValidatedExecutionRequest): Promise<void> {
    const { runValidatedExecutionRequest } =
      await import('@agent/runtime/runExecutionRequest');
    await runValidatedExecutionRequest(request, {
      runtimeHost: this.runtimeHost,
      openWorkflowOutput: async (result) => {
        const output = result.outputs.at(-1);
        if (output) {
          await this.options.openPath?.(output.absolutePath);
        }
      },
    });
  }
}

export function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): DesktopAgentExecution {
  const progress = new DesktopProgressBridge(options.postToRenderer, {
    openPath: options.opener?.openPath,
    openBuildDisplay: options.opener?.openBuildDisplay,
    showMessage: async (message) => options.showErrorMessage?.(message),
  });

  return {
    progress,
    async handleExecute(message) {
      const preparation = prepareMainViewExecutionRequest(message);
      if (!preparation.valid) {
        await options.showErrorMessage?.(preparation.message);
        return;
      }

      await progress.runExecution(preparation.request);
    },
    dispose() {
      progress.dispose();
    },
  };
}
