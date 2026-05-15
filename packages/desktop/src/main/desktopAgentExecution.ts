import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildStreamTabInfo,
  peekWorktreeInfo,
  resolveWorktreeInfo,
} from '@agent/index';

import {
  prepareMainViewExecutionRequest,
  type MainViewExecuteMessage,
} from '@controllers/mainView/MainViewExecutionController';
import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform, tryPlatform } from '@platform/platform';
import type { ValidatedExecutionRequest } from '@agent/core/executionRequests';
import {
  clearRetryRequest,
  resolvePlanApproval,
  resolveProposal,
} from '@agent/runtime/runCoordinators';
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
import {
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { DiffViewHost } from '@hosts/diffViewHost';
import type { ExternalOpener } from '@hosts/externalOpener';
import { getAcceptedFileTarget } from '@latex/acceptedFileTarget';
import { LaTeXdiffService } from '@latex/latexdiff';
import { DEFAULT_MATH_MARKUP } from '@latex/latexdiff/mathMarkup';
import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';
import {
  STREAM_STATUS,
  type ActiveChildInfo,
  type AgentProposalPermission,
  type AgentCategory,
  type AgentCategoryFilter,
  type ConversationProgress,
  type OutputFileInfo,
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
import { handleUserQuestionAction } from '@tools/userQuestion';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import {
  createExternalLocation,
  pathToLocation,
  type FileLocation,
} from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

import { DESKTOP_SHELL_COMMANDS } from '../desktopShellMessages.js';
import type { DesktopStreamSnapshotStore } from './desktopStreamSnapshot.js';
import type { RestoredStreamSnapshot } from '@shared/schemas';
import {
  createDesktopToolEditApprovalController,
  type DesktopToolEditApprovalController,
} from './desktopToolEditApproval.js';

export interface DesktopAgentExecutionOptions {
  postToRenderer(message: unknown): void;
  opener?: Pick<ExternalOpener, 'openPath'> & {
    openBuildDisplay?: BuildDisplayFn;
  };
  diff?: Pick<DiffViewHost, 'openDiff'>;
  confirmAcceptFile?: (message: string) => Promise<boolean>;
  showErrorMessage?: (message: string) => Promise<void> | void;
  showInfoMessage?: (message: string) => Promise<void> | void;
  /**
   * Optional snapshot store wired by the desktop entrypoint. When
   * provided, the bridge persists a slim snapshot of the rail on each
   * stream change (audit item D / trajectory #19) and surfaces
   * previously-persisted "ghost" streams in the rail at launch.
   */
  streamSnapshotStore?: DesktopStreamSnapshotStore;
}

export interface DesktopAgentExecution {
  handleExecute(message: MainViewExecuteMessage): Promise<void>;
  progress: DesktopProgressBridge;
  dispose(): void;
}

type TaskState = ProgressEventPayloads['setTaskState']['taskState'];
type OutputFilesByRound = Map<number, OutputFileInfo[]>;

type StreamBadgeSnapshot = {
  activeSubagents: ActiveChildInfo[];
  finishedSubagentCount: number;
  activeProcesses: ActiveChildInfo[];
  finishedProcessCount: number;
};

export interface DesktopProgressBridgeOptions {
  detachSubagentsOnStop?: boolean;
  openPath?: (filePath: string, line?: number) => Promise<void>;
  openBuildDisplay?: BuildDisplayFn;
  openDiff?: DiffViewHost['openDiff'];
  confirmAcceptFile?: (message: string) => Promise<boolean>;
  showInfoMessage?: (message: string) => Promise<void>;
  showErrorMessage?: (message: string) => Promise<void>;
  streamSnapshotStore?: DesktopStreamSnapshotStore;
}

function toFileLocation(filePath: string): FileLocation {
  return path.isAbsolute(filePath)
    ? createExternalLocation(filePath)
    : pathToLocation(filePath);
}

export class DesktopProgressBridge {
  private readonly streamLogs = new StreamLogStore();
  private readonly logger = new AgentLogger('DesktopProgressBridge');
  private readonly agentProposalController: ProgressAgentProposalController;
  private readonly workflowFileActions: ProgressWorkflowFileActionsController;
  private readonly cursors = new Map<StreamTabId, number>();
  private readonly taskStates = new Map<StreamTabId, TaskState>();
  private readonly agentProposals = new Map<string, AgentProposalPermission>();
  private readonly outputFiles = new Map<StreamTabId, OutputFilesByRound>();
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
  private readonly toolEditApprovals: DesktopToolEditApprovalController;
  /**
   * Restored "ghost" streams hydrated from the cross-launch snapshot.
   * Keyed by streamId. An entry is removed once a live progress event
   * with the same id arrives (the live entry takes over and the
   * ghost is no longer needed). Audit item D / trajectory #19.
   */
  private readonly restoredStreams = new Map<
    StreamTabId,
    RestoredStreamSnapshot
  >();

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
    this.toolEditApprovals = createDesktopToolEditApprovalController({
      runtimeHost: this.runtimeHost,
      openPath: options.openPath,
      openBuildDisplay: options.openBuildDisplay,
      openDiff: options.openDiff,
      showErrorMessage: (message) => this.showErrorMessage(message),
    });
    this.workflowFileActions = new ProgressWorkflowFileActionsController({
      state: {
        getActiveStream: () => this.activeStream,
        getExecutionId: (stream) => this.executionIds.get(stream),
        getOutputFiles: (stream) => new Map(this.outputFiles.get(stream) ?? []),
      },
      host: {
        compareFiles: (baseFile, editedFile) =>
          this.compareFiles(baseFile, editedFile),
        acceptEditedFile: (baseFile, editedFile) =>
          this.acceptEditedFile(baseFile, editedFile),
        mergeFile: (baseFile, editedFile) =>
          this.runMergeFile(baseFile, editedFile),
        latexdiffFile: (baseFile, editedFile) =>
          this.runLatexdiffFile(baseFile, editedFile),
        openDirectory: async (directory) => {
          await this.options.openPath?.(directory);
        },
        openLabel: (label) => this.findAndOpenLabel(label),
        readFile: (file) => readFile(file, 'utf8'),
        showInfo: (message) => this.showInfoMessage(message),
        showError: (message) => this.showErrorMessage(message),
        logError: (message, error) => {
          this.logger.error(message, {
            data: error instanceof Error ? error : { error },
          });
        },
      },
      sendFollowUp: async (stream, text) => {
        await this.sendFollowUp(stream, text);
      },
    });
    this.agentProposalController = new ProgressAgentProposalController({
      getPendingProposal: (proposalId) => this.agentProposals.get(proposalId),
      restoreTaskState: async (taskState) => {
        let state: ReturnType<typeof buildMainViewState>;
        try {
          state = buildMainViewState(taskState);
        } catch {
          return false;
        }
        this.postToRenderer({
          command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
          route: 'main',
        });
        this.postToRenderer({
          command: COMMON_COMMANDS.STATE_RESTORE,
          state,
        });
        return true;
      },
      resolveProposal: (proposalId, result) => {
        resolveProposal(proposalId, result);
      },
      onMissingProposal: (proposalId) => {
        this.logger.warn(
          `No pending desktop agent proposal found for setup: ${proposalId}`,
        );
      },
      onInvalidProposal: (issues) => {
        this.logger.warn('Invalid desktop agent proposal config', {
          data: { errors: issues },
        });
      },
      onSetupComplete: (proposal) => {
        this.logger.info(
          `Desktop agent proposal ${proposal.proposalId} set up in main view`,
          {
            data: { agent: proposal.agent },
          },
        );
      },
    });

    // Hydrate previously-persisted "ghost" streams so the rail shows
    // the user's prior runs at launch (audit item D / trajectory #19).
    // We seed creation timestamps, statuses, descriptions, executionIds,
    // and categories from the snapshot — but NOT taskState, since we
    // can't resurrect runtime state. The renderer will show these as
    // stopped/orphaned entries; "Resume run" funnels back through the
    // existing storage-backed resume path when an executionId is
    // available, otherwise falls back to "start fresh".
    const hydrated = options.streamSnapshotStore?.hydrated ?? [];
    for (const snapshot of hydrated) {
      this.restoredStreams.set(snapshot.streamId, snapshot);
      this.creationTimestamps.set(
        snapshot.streamId,
        snapshot.creationTimestamp,
      );
      this.categories.set(snapshot.streamId, snapshot.agentCategory);
      this.statuses.set(snapshot.streamId, snapshot.lastKnownStatus);
      if (snapshot.description) {
        this.descriptions.set(snapshot.streamId, snapshot.description);
      }
      if (snapshot.executionId) {
        this.executionIds.set(snapshot.streamId, snapshot.executionId);
      }
    }
  }

  /**
   * Build a RestoredStreamSnapshot for `streamId` from current bridge
   * state and forward it to the persistence store. Best-effort: any
   * write error is logged but never thrown — persistence problems
   * must not break agent execution.
   */
  private persistStreamSnapshot(streamId: StreamTabId): void {
    const store = this.options.streamSnapshotStore;
    if (!store) return;

    const taskState = this.taskStates.get(streamId);
    const restored = this.restoredStreams.get(streamId);
    const category =
      taskState?.agentConfig.agentCategory ??
      this.categories.get(streamId) ??
      restored?.agentCategory ??
      AGENT_CATEGORY.WORKFLOW;
    const info = this.buildStreamInfo(streamId);
    const snapshot: RestoredStreamSnapshot = {
      streamId,
      label: info.label,
      agent: info.agent ?? restored?.agent,
      agentCategory: category,
      inputFile: info.inputFile || restored?.inputFile,
      instruction: taskState?.agentConfig.instruction || restored?.instruction,
      lastKnownStatus:
        this.statuses.get(streamId) ??
        restored?.lastKnownStatus ??
        STREAM_STATUS.STOPPED,
      description: this.descriptions.get(streamId) ?? restored?.description,
      executionId: this.executionIds.get(streamId) ?? restored?.executionId,
      creationTimestamp: this.getCreationTimestamp(streamId),
      lastTimestamp:
        this.streamLogs.getLastTimestamp(streamId) ?? restored?.lastTimestamp,
      persistedAt: Date.now(),
    };
    void store.upsert(snapshot).catch((error: unknown) => {
      this.logger.warn('Failed to persist stream snapshot', {
        data: error instanceof Error ? error : { error },
      });
    });
  }

  private removePersistedStream(streamId: StreamTabId): void {
    this.restoredStreams.delete(streamId);
    const store = this.options.streamSnapshotStore;
    if (!store) return;
    void store.remove(streamId).catch((error: unknown) => {
      this.logger.warn('Failed to remove persisted stream snapshot', {
        data: error instanceof Error ? error : { error },
      });
    });
  }

  dispose(): void {
    this.toolEditApprovals.dispose();
    this.unsubscribe();
    this.agentProposals.clear();
    this.cursors.clear();
    this.taskStates.clear();
    this.outputFiles.clear();
    this.statuses.clear();
    this.categories.clear();
    this.executionIds.clear();
    this.descriptions.clear();
    this.parentStreams.clear();
    this.creationTimestamps.clear();
    this.conversationProgress.clear();
    this.streamBadges.clear();
    // Bot review (#3819) caught the omission — `deleteAllStreams()`
    // already clears `restoredStreams`; `dispose()` should match.
    this.restoredStreams.clear();
    this.workflowFileActions.clearAllBackups();
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
    const restored = this.restoredStreams.get(streamId);
    const workingDirectory =
      taskState?.agentConfig.workingDirectory ?? undefined;
    let worktreeInfo;
    if (workingDirectory) {
      worktreeInfo = peekWorktreeInfo(workingDirectory);
      this.ensureWorktreeProbe(workingDirectory);
    }
    return buildStreamTabInfo({
      streamId,
      config: taskState?.agentConfig,
      hints: {
        agent: restored?.agent,
        agentCategory: this.categories.get(streamId) ?? restored?.agentCategory,
        inputFile: restored?.inputFile,
      },
      creationTimestamp: this.getCreationTimestamp(streamId),
      executionId: this.executionIds.get(streamId),
      parentStreamId: this.parentStreams.get(streamId),
      description: this.descriptions.get(streamId),
      worktreeInfo,
    });
  }

  private readonly probedWorktreeDirs = new Set<string>();

  private ensureWorktreeProbe(workingDirectory: string): void {
    if (this.probedWorktreeDirs.has(workingDirectory)) return;
    this.probedWorktreeDirs.add(workingDirectory);
    void resolveWorktreeInfo(workingDirectory).catch(() => {
      this.probedWorktreeDirs.delete(workingDirectory);
    });
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
    const liveIds = new Set(this.streamLogs.keys());
    const liveStreams = [...liveIds].map((id) => this.buildStreamInfo(id));

    // Restored "ghost" entries that haven't been replaced by live
    // events yet. We surface them on the rail so the user can see the
    // runs they had going (audit item D / trajectory #19). Skipping
    // ghosts whose id is already in `liveIds` prevents duplicates when
    // a previous run resumed in the same launch.
    const ghostStreams: StreamTabInfo[] = [];
    for (const [id, snapshot] of this.restoredStreams) {
      if (liveIds.has(id)) continue;
      ghostStreams.push(this.buildGhostStreamInfo(snapshot));
    }

    const streams = [...liveStreams, ...ghostStreams];
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

  private buildGhostStreamInfo(
    snapshot: RestoredStreamSnapshot,
  ): StreamTabInfo {
    return buildStreamTabInfo({
      streamId: snapshot.streamId,
      hints: {
        agent: snapshot.agent,
        agentCategory: snapshot.agentCategory,
        inputFile: snapshot.inputFile,
      },
      creationTimestamp: snapshot.creationTimestamp,
      executionId: snapshot.executionId,
      description: snapshot.description,
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
        // Live event arrived for what may have been a ghost. Drop the
        // ghost entry — the live stream owns the rail row now.
        this.restoredStreams.delete(data.streamId);
        this.persistStreamSnapshot(data.streamId);
        this.syncStreams();
        break;
      }
      case 'updateStreamStatus': {
        const data = payload as ProgressEventPayloads['updateStreamStatus'];
        const wasKnownStream = this.streamLogs.has(data.streamId);
        this.ensureStream(data.streamId);
        this.statuses.set(data.streamId, data.status);
        this.restoredStreams.delete(data.streamId);
        this.persistStreamSnapshot(data.streamId);
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
        const existing = this.outputFiles.get(data.streamId) ?? new Map();
        for (const [round, files] of Object.entries(data.filesByRound)) {
          existing.set(Number(round), files);
        }
        this.outputFiles.set(data.streamId, existing);
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
        this.persistStreamSnapshot(data.streamId);
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
        const data = payload as ProgressEventPayloads['showAgentProposal'];
        this.agentProposals.set(data.proposalId, data);
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'show',
          permission: {
            kind: 'proposal',
            data,
          },
        });
        break;
      }
      case 'resolveAgentProposal': {
        const data = payload as ProgressEventPayloads['resolveAgentProposal'];
        this.agentProposals.delete(data.proposalId);
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
      case 'showUserQuestion': {
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'show',
          permission: {
            kind: 'userQuestion',
            data: payload as ProgressEventPayloads['showUserQuestion'],
          },
        });
        break;
      }
      case 'resolveUserQuestion': {
        const data = payload as ProgressEventPayloads['resolveUserQuestion'];
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
          action: 'resolve',
          kind: 'userQuestion',
          id: data.requestId,
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
    if (
      !this.streamLogs.has(streamId) &&
      !this.taskStates.has(streamId) &&
      !this.restoredStreams.has(streamId)
    ) {
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
      this.streamLogs.has(streamId) ||
      this.taskStates.has(streamId) ||
      this.restoredStreams.has(streamId);
    if (!hadStream) return;
    this.removePersistedStream(streamId);

    // Shared approval cleanup also owns retry/proposal/plan coordinator cleanup.
    cleanupApprovalsForStream(streamId);
    ToolUseFollowUpQueue.release(streamId);

    await this.streamLogs.delete(streamId);
    this.taskStates.delete(streamId);
    this.outputFiles.delete(streamId);
    this.statuses.delete(streamId);
    this.categories.delete(streamId);
    this.executionIds.delete(streamId);
    this.deleteAgentProposalsForStream(streamId);
    this.descriptions.delete(streamId);
    this.parentStreams.delete(streamId);
    this.creationTimestamps.delete(streamId);
    this.conversationProgress.delete(streamId);
    this.streamBadges.delete(streamId);
    this.workflowFileActions.clearStreamBackups(streamId);
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
    // Shared approval cleanup also owns retry/proposal/plan coordinator cleanup.
    cleanupAllApprovals();
    for (const streamId of this.streamLogs.keys()) {
      ToolUseFollowUpQueue.release(streamId);
    }
    // Drop persisted ghosts too: a "delete all" should leave nothing
    // for the next launch to hydrate, otherwise users would see the
    // ghosts come back zombie-style after relaunch.
    this.restoredStreams.clear();
    if (this.options.streamSnapshotStore) {
      void this.options.streamSnapshotStore
        .replaceAll([])
        .catch((error: unknown) => {
          this.logger.warn('Failed to clear stream snapshot store', {
            data: error instanceof Error ? error : { error },
          });
        });
    }

    await this.streamLogs.clear();
    this.cursors.clear();
    this.taskStates.clear();
    this.outputFiles.clear();
    this.statuses.clear();
    this.categories.clear();
    this.executionIds.clear();
    this.agentProposals.clear();
    this.descriptions.clear();
    this.parentStreams.clear();
    this.creationTimestamps.clear();
    this.conversationProgress.clear();
    this.streamBadges.clear();
    this.workflowFileActions.clearAllBackups();
    this.activeStream = '';
    this.send({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL });
    this.syncStreams();
  }

  stopStream(streamId: StreamTabId): void {
    clearRetryRequest(streamId);
    if (this.options.detachSubagentsOnStop === true) {
      detachActiveChildren(streamId, this.runtimeHost);
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
    if (!taskState) {
      // Ghost stream from a prior launch: we don't have taskState in
      // memory and reviving the runtime is out of scope (audit item
      // D Phase 2). Surface a clear message rather than silently no-op.
      if (this.restoredStreams.has(streamId)) {
        await this.showInfoMessage(
          'This run is from a previous session. Live resume is not yet supported — please start a fresh run.',
        );
      }
      return;
    }

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

    await this.showInfoMessage(
      'No active session. Start a new agent task to continue.',
    );
  }

  async openFile(filePath: string, line?: number): Promise<void> {
    await this.options.openPath?.(filePath, line);
  }

  async openFileCompile(filePath: string): Promise<void> {
    if (this.options.openBuildDisplay) {
      await this.options.openBuildDisplay(toFileLocation(filePath));
      return;
    }
    await this.showErrorMessage(
      'Desktop LaTeX preview is unavailable. Cannot compile and open this file.',
    );
  }

  async openTaskStorage(streamId: StreamTabId): Promise<void> {
    await this.workflowFileActions.openTaskStorage(streamId);
  }

  async compareOriginal(file: string, base?: string): Promise<void> {
    await this.workflowFileActions.compareOriginal(file, base);
  }

  async comparePrevious(
    file: string,
    base?: string,
    previous?: string,
  ): Promise<void> {
    await this.workflowFileActions.comparePrevious(file, base, previous);
  }

  async acceptFile(file: string, base?: string): Promise<void> {
    await this.workflowFileActions.acceptFile(file, base);
  }

  async mergeFile(file: string, base?: string): Promise<void> {
    await this.workflowFileActions.mergeFile(file, base);
  }

  async latexdiffFile(file: string, base?: string): Promise<void> {
    await this.workflowFileActions.latexdiffFile(file, base);
  }

  async openLabel(label: string): Promise<void> {
    await this.workflowFileActions.openLabel(label);
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
    return this.toolEditApprovals.handleAction(message);
  }

  handlePlanApprovalAction(
    message: Extract<
      ProgressViewInboundMessage,
      { command: typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION }
    >,
  ): void {
    resolvePlanApproval(message.approvalId, {
      action: message.action,
      ...(message.action === 'reject' && { feedback: message.feedback }),
    });
  }

  async handleUserQuestionAction(
    message: Extract<
      ProgressViewInboundMessage,
      { command: typeof PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION }
    >,
  ): Promise<void> {
    await handleUserQuestionAction(message);
  }

  async handleAgentProposalAction(
    message: Extract<
      ProgressViewInboundMessage,
      { command: typeof PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION }
    >,
  ): Promise<boolean> {
    return this.agentProposalController.handleAction(message);
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

  private async compareFiles(
    baseFile: string,
    editedFile: string,
  ): Promise<void> {
    if (!this.options.openDiff) {
      await this.showErrorMessage(
        'Desktop file comparison is not available in this host yet.',
      );
      return;
    }

    await this.options.openDiff(
      { filePath: baseFile },
      { filePath: editedFile },
      `Compare: ${path.basename(editedFile)} <-> ${path.basename(baseFile)}`,
    );
  }

  private async runMergeFile(
    baseFile: string,
    editedFile: string,
  ): Promise<void> {
    const [{ executeMergeAgent }, { getHelperModelName }] = await Promise.all([
      import('@agent/runtime/executeAgent'),
      import('@agent/runtime/helperModel'),
    ]);
    await executeMergeAgent(
      getHelperModelName(),
      baseFile,
      editedFile,
      this.runtimeHost,
    );
  }

  private async acceptEditedFile(
    baseFile: string,
    editedFile: string,
  ): Promise<boolean> {
    const baseLocation = pathToLocation(baseFile);
    const editedLocation = pathToLocation(editedFile);
    const { targetLocation, targetFileName, isNewFile } = getAcceptedFileTarget(
      baseLocation,
      editedLocation.absolutePath,
    );
    const targetExists =
      isNewFile && (await fileExists(targetLocation.absolutePath));
    let action: string;
    if (targetExists) action = 'overwrite existing';
    else if (isNewFile) action = 'create';
    else action = 'overwrite';
    const extensionNote = isNewFile
      ? `Extensions differ (${path.extname(baseFile).toLowerCase()} vs ${path.extname(editedFile).toLowerCase()}). `
      : '';
    const confirmMessage = `${extensionNote}This will ${action} '${targetFileName}' with content from '${path.basename(editedFile)}'. Are you sure?`;

    if (this.options.confirmAcceptFile) {
      const confirmed = await this.options.confirmAcceptFile(confirmMessage);
      if (!confirmed) return false;
    }

    const editedContent = await readFile(editedLocation.absolutePath, 'utf8');
    await writeFile(targetLocation.absolutePath, editedContent, 'utf8');
    if (targetLocation.kind === 'workspace') {
      this.runtimeHost.emit('workspaceFilesWritten', {
        absolutePaths: [targetLocation.absolutePath],
      });
    }

    const operation = isNewFile && !targetExists ? 'created' : 'replaced';
    await this.showInfoMessage(
      `Successfully ${operation} '${targetFileName}' with content from '${path.basename(editedFile)}'`,
    );
    return true;
  }

  private async runLatexdiffFile(
    baseFile: string,
    editedFile: string,
  ): Promise<void> {
    const service = new LaTeXdiffService('DesktopProgressBridge');
    const result = await service.runDiff(
      pathToLocation(baseFile),
      pathToLocation(editedFile),
      '_diff',
      false,
      DEFAULT_MATH_MARKUP,
    );

    if (!result.success || !result.diffFileName) {
      await this.showErrorMessage(
        result.message ?? 'Failed to generate diff file.',
      );
      return;
    }

    const diffFilePath = path.join(path.dirname(baseFile), result.diffFileName);
    if (this.options.openBuildDisplay) {
      await this.options.openBuildDisplay(createExternalLocation(diffFilePath));
      return;
    }
    await this.options.openPath?.(diffFilePath);
  }

  private async findAndOpenLabel(label: string): Promise<boolean> {
    const workspacePath = platform().workspace.getWorkspacePath();
    if (!workspacePath) return false;

    const escape = label.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\\\label\\{${escape}\\}`, 'm');
    const candidates = new Set([
      ...(await this.listWorkspaceFiles('input')),
      ...(await this.listWorkspaceFiles('reference')),
    ]);

    for (const file of candidates) {
      const filePath = path.isAbsolute(file)
        ? file
        : path.join(workspacePath, file);
      try {
        const content = await readFile(filePath, 'utf8');
        if (pattern.test(content)) {
          await this.options.openPath?.(filePath);
          return true;
        }
      } catch {
        // Ignore unreadable candidates and continue scanning.
      }
    }

    return false;
  }

  private deleteAgentProposalsForStream(streamId: StreamTabId): void {
    for (const [proposalId, proposal] of this.agentProposals.entries()) {
      if (proposal.streamId === streamId) {
        this.agentProposals.delete(proposalId);
      }
    }
  }

  private async listWorkspaceFiles(
    fileType: ListableFileType,
  ): Promise<string[]> {
    const workspacePath = platform().workspace.getWorkspacePath();
    const config = getFileListConfig(fileType, loadFileListSettings(getConfig));
    if (!workspacePath || !config) return [];
    return listWorkspaceFiles({
      root: workspacePath,
      config,
      readDirectory: (directory) =>
        (tryPlatform()?.fs ?? nodeFilesystem).readDirectory(directory),
    });
  }

  private async showInfoMessage(message: string): Promise<void> {
    await this.options.showInfoMessage?.(message);
  }

  private async showErrorMessage(message: string): Promise<void> {
    await this.options.showErrorMessage?.(message);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): DesktopAgentExecution {
  const progress = new DesktopProgressBridge(options.postToRenderer, {
    openPath: options.opener?.openPath,
    openBuildDisplay: options.opener?.openBuildDisplay,
    openDiff: options.diff?.openDiff,
    confirmAcceptFile: options.confirmAcceptFile,
    showInfoMessage: async (message) => options.showInfoMessage?.(message),
    showErrorMessage: async (message) => options.showErrorMessage?.(message),
    streamSnapshotStore: options.streamSnapshotStore,
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
