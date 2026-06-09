import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  prepareMainViewExecutionRequest,
  type MainViewExecuteMessage,
} from '@controllers/mainView/MainViewExecutionController';

import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { createProgressViewCommandHandlers } from '@controllers/progressView/ProgressViewCommandHandlers';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform, tryPlatform } from '@platform/platform';
import { StreamSnapshotStore } from '@transcript';
import { streamDataDir } from '@transcript/streamDataPaths';
import { readMeta } from '@transcript/streamSnapshotRead';
import type { AgentTrace } from '@agent/trace';
import type { ValidatedExecutionRequest } from '@agent/core/execution/executionRequests';
import {
  TaskStateSchema,
  type TaskState,
} from '@agent/core/execution/TaskState';
import { runCoordinatorBridge } from '@agent/runtime/runCoordinators';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { resumeToolUseFromSnapshot } from '@agent/runtime/executeAgent';
import { executionRegistry } from '@agent/runtime/executionRegistry';
import { setProgressViewBridge } from '@agent/runtime/ProgressViewBridge';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { toErrorMessage } from '@common/errors';
import {
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { KVStore } from '@common/storage/KVStore';
import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { DiffViewHost } from '@hosts/diffViewHost';
import type { ExternalOpener } from '@hosts/externalOpener';
import {
  buildAcceptConfirmMessage,
  buildAcceptSuccessMessage,
  getAcceptedFileTarget,
} from '@latex/acceptedFileTarget';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { LaTeXdiffService } from '@latex/latexdiff';
import { DEFAULT_MATH_MARKUP } from '@latex/latexdiff/mathMarkup';
import { createChannelTrace } from '@logger';
import {
  STREAM_STATUS,
  type AgentProposalPermission,
  type AgentCategoryFilter,
  type MainViewPersistedState,
  type ProgressViewOutboundMessage,
  type ExecutionId,
  type RestoredStreamSnapshot,
  type StreamTabId,
} from '@shared/schemas';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { ProgressBackend } from '@shared/progressView/backend/ProgressBackend';
import { buildStreamInfo } from '@shared/progressView/backend/streamInfoUtils';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import { COMMON_COMMANDS } from '@shared/ipc/commonCommands';
import { AGENT_CATEGORY } from '@shared/schemas/agent';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import {
  cleanupAllApprovals,
  cleanupApprovalsForStream,
  handleProgressViewBashApprovalAction,
} from '@tools/approval';
import { OdysseyStore, isOdysseyInFlight } from '@tools/odyssey';
import { handleUserQuestionAction } from '@tools/userQuestion';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import {
  AbsoluteFS,
  createExternalLocation,
  pathToLocation,
  type FileLocation,
} from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

import { DESKTOP_SHELL_COMMANDS } from '../desktopShellMessages.js';
import {
  createDesktopToolEditApprovalController,
  type DesktopToolEditApprovalController,
} from './desktopToolEditApproval.js';
import type { DesktopStreamSnapshotStore } from './desktopStreamSnapshot.js';

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
  progressSnapshotStore?: StreamSnapshotStore;
}

export interface DesktopAgentExecution {
  handleExecute(message: MainViewExecuteMessage): Promise<void>;
  progress: DesktopProgressBridge;
  dispose(): void;
}

type ResumeState = {
  taskState: TaskState;
  executionId?: ExecutionId;
};

type PersistedResumeMeta = {
  taskState?: TaskState;
  executionId?: ExecutionId;
  description?: string;
  parentStreamId?: StreamTabId;
};

export interface DesktopProgressBridgeOptions {
  detachSubagentsOnStop?: boolean;
  openPath?: (filePath: string, line?: number) => Promise<void>;
  openBuildDisplay?: BuildDisplayFn;
  openDiff?: DiffViewHost['openDiff'];
  confirmAcceptFile?: (message: string) => Promise<boolean>;
  showInfoMessage?: (message: string) => Promise<void> | void;
  showErrorMessage?: (message: string) => Promise<void> | void;
  streamSnapshotStore?: DesktopStreamSnapshotStore;
  progressSnapshotStore?: StreamSnapshotStore;
}

function toFileLocation(filePath: string): FileLocation {
  return path.isAbsolute(filePath)
    ? createExternalLocation(filePath)
    : pathToLocation(filePath);
}

class MemoryProgressStorage implements MementoStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update<T>(key: string, value: T | undefined): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
      return;
    }
    this.values.set(key, value);
  }
}

export class DesktopProgressBridge {
  private readonly logger: AgentTrace = createChannelTrace(
    'DesktopProgressBridge',
  );
  private readonly backend: ProgressBackend;
  private readonly state: ProgressBackend['state'];
  readonly streamLogs: ProgressBackend['state']['streamLogs'];
  private readonly agentProposalController: ProgressAgentProposalController;
  private readonly workflowFileActions: ProgressWorkflowFileActionsController;
  private readonly agentProposals = new Map<string, AgentProposalPermission>();
  private readonly resumeAttempts = new Set<StreamTabId>();
  private readonly deletedStreams = new Set<StreamTabId>();
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
  /** Ghost streams whose persisted display has already been restored this session. */
  private readonly restoredDisplaySent = new Set<StreamTabId>();
  /** Ghost streams with an async persisted-display restore already pending. */
  private readonly restoredDisplayInFlight = new Set<StreamTabId>();

  readonly runtimeHost: AgentRuntimeHost;
  readonly progressViewInboundHandlers: ProgressViewInboundHandlerRegistry;

  constructor(
    private readonly postToRenderer: (message: unknown) => void,
    private readonly options: DesktopProgressBridgeOptions = {},
  ) {
    setProgressViewBridge({ isViewVisible: () => true });
    this.backend = new ProgressBackend({
      storage: tryPlatform()?.workspaceState ?? new MemoryProgressStorage(),
      snapshots: options.progressSnapshotStore ?? new StreamSnapshotStore(),
      sendMessage: (message) => {
        this.postToRenderer(message);
        return true;
      },
      hasTarget: () => true,
      configureUi: ({ webviewUpdater }) => ({
        callbacks: {
          showRetryRequest: () => undefined,
          resolveRetryRequest: () => undefined,
          showToolEditPermission: (payload) =>
            webviewUpdater.showPermission({
              kind: PERMISSION_KIND.TOOL_EDIT,
              data: payload,
            }),
          resolveToolEditPermission: (requestId) =>
            webviewUpdater.resolvePermission(
              PERMISSION_KIND.TOOL_EDIT,
              requestId,
            ),
          updateToolEditApprovalBypassState: (streamId, bypassActive) =>
            webviewUpdater.updateBypassState(
              streamId,
              'toolEdit',
              bypassActive,
            ),
          updateSuperYoloBypassState: (streamId, bypassActive) =>
            webviewUpdater.updateBypassState(
              streamId,
              'superYolo',
              bypassActive,
            ),
          showBashPermission: (payload) =>
            webviewUpdater.showPermission({
              kind: PERMISSION_KIND.BASH,
              data: payload,
            }),
          resolveBashPermission: (requestId) =>
            webviewUpdater.resolvePermission(PERMISSION_KIND.BASH, requestId),
          showAgentProposal: (payload) => {
            this.agentProposals.set(payload.proposalId, payload);
            webviewUpdater.showPermission({
              kind: PERMISSION_KIND.PROPOSAL,
              data: payload,
            });
          },
          resolveAgentProposal: (proposalId) => {
            this.agentProposals.delete(proposalId);
            webviewUpdater.resolvePermission(
              PERMISSION_KIND.PROPOSAL,
              proposalId,
            );
          },
          showPlanApproval: (payload) =>
            webviewUpdater.showPermission({
              kind: PERMISSION_KIND.PLAN_APPROVAL,
              data: payload,
            }),
          resolvePlanApproval: (approvalId) =>
            webviewUpdater.resolvePermission(
              PERMISSION_KIND.PLAN_APPROVAL,
              approvalId,
            ),
          showExternalInquiry: () => undefined,
          resolveExternalInquiry: () => undefined,
          showUserQuestion: (payload) =>
            webviewUpdater.showPermission({
              kind: PERMISSION_KIND.USER_QUESTION,
              data: payload,
            }),
          resolveUserQuestion: (requestId) =>
            webviewUpdater.resolvePermission(
              PERMISSION_KIND.USER_QUESTION,
              requestId,
            ),
        },
        hasPendingPermissions: () => false,
      }),
    });
    this.state = this.backend.state;
    this.streamLogs = this.state.streamLogs;
    const backendSubscription = this.backend.setupEventListeners();
    const unsubscribeOdyssey = bus.on('odysseyStateChanged', ({ streamId }) => {
      this.updateOdysseyActiveFromStore(streamId);
    });
    const unsubscribeEnsureProgress = bus.on(
      'requestEnsureProgressView',
      () => {
        this.routeToProgress();
      },
    );
    this.unsubscribe = () => {
      backendSubscription.dispose();
      unsubscribeOdyssey();
      unsubscribeEnsureProgress();
    };
    this.runtimeHost = {
      emit: (event, payload) => this.handleProgressEvent(event, payload),
    };
    this.toolEditApprovals = createDesktopToolEditApprovalController({
      runtimeHost: this.runtimeHost,
      openPath: options.openPath,
      openBuildDisplay: options.openBuildDisplay,
      openDiff: options.openDiff,
      showErrorMessage: this.options.showErrorMessage,
    });
    this.workflowFileActions = new ProgressWorkflowFileActionsController({
      state: {
        getActiveStream: () => this.state.activeStream,
        getExecutionId: (stream) => this.getStreamExecutionId(stream),
        getOutputFiles: (stream) =>
          new Map(this.state.snapshots.getOutputFiles(stream)),
        // The desktop bridge has no quick-pick UI, so Accept always replaces
        // the workspace file. Returning undefined keeps the controller from
        // building copy metadata that the desktop host would silently drop.
        getAgentModel: () => undefined,
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
        showInfo: async (message) => {
          await this.options.showInfoMessage?.(message);
        },
        showError: async (message) => {
          await this.options.showErrorMessage?.(message);
        },
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
        let state: MainViewPersistedState;
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
        runCoordinatorBridge.resolveProposal(proposalId, result);
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
    this.progressViewInboundHandlers = this.createProgressViewInboundHandlers();

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
      this.state.streamLogs.ensureStream(snapshot.streamId);
      this.state.updateStreamHints(snapshot.streamId, {
        agent: snapshot.agent,
        agentCategory: snapshot.agentCategory,
        inputFile: snapshot.inputFile,
        creationTimestamp: snapshot.creationTimestamp,
        executionId: snapshot.executionId,
        parentStreamId: snapshot.parentStreamId,
        description: snapshot.description,
      });
      StreamStatusService.set(snapshot.streamId, snapshot.lastKnownStatus, {
        emit: false,
      });
    }
  }

  private createProgressViewInboundHandlers(): ProgressViewInboundHandlerRegistry {
    return createProgressViewCommandHandlers({
      lifecycle: {
        setActiveStream: (stream) => this.setActiveStream(stream),
        setAgentFilter: (filter) => this.setAgentFilter(filter),
        deleteStream: (stream) => this.deleteStream(stream),
        deleteAllStreams: () => this.deleteAllStreams(),
        stopStream: (stream) => this.stopStream(stream),
      },
      run: {
        resumeStream: async (stream) => {
          await this.tryResumeStream(stream);
        },
        runNewStream: (stream) => this.runNewStream(stream),
      },
      followUp: {
        sendFollowUp: ({ stream, text, mediaFiles }) =>
          this.sendFollowUp(stream, text, mediaFiles),
        reportImageSaveError: (image, error) => {
          this.logger.warn(
            `Failed to save pasted follow-up image ${image.fileName}`,
            { data: error instanceof Error ? error : { error } },
          );
        },
      },
      bypass: {
        runtimeHost: this.runtimeHost,
      },
      file: {
        openFile: async (file, line) => {
          await this.options.openPath?.(file, line);
        },
        openFileCompile: (file) => this.openFileCompile(file),
        openTaskStorage: (stream) =>
          this.workflowFileActions.openTaskStorage(stream),
        compareOriginal: (file, base) =>
          this.workflowFileActions.compareOriginal(file, base),
        comparePrevious: (file, base, previous) =>
          this.workflowFileActions.comparePrevious(file, base, previous),
        acceptFile: (file, base) =>
          this.workflowFileActions.acceptFile(file, base),
        mergeFile: (file, base) =>
          this.workflowFileActions.mergeFile(file, base),
        latexdiffFile: (file, base) =>
          this.workflowFileActions.latexdiffFile(file, base),
        openLabel: (label) => this.workflowFileActions.openLabel(label),
      },
      approval: {
        handleToolEditApprovalAction: (message) =>
          this.toolEditApprovals.handleAction(message),
        onUnsupportedToolEditApproval: (message) => {
          this.logger.warn('Unsupported desktop tool-edit approval action', {
            data: {
              requestId: message.requestId,
              action: message.action,
            },
          });
        },
        handleBashApprovalAction: (message) =>
          handleProgressViewBashApprovalAction(message),
        handlePlanApprovalAction: (message) => {
          runCoordinatorBridge.resolvePlanApproval(message.approvalId, {
            action: message.action,
            ...(message.action === 'reject' && {
              feedback: message.feedback,
            }),
          });
        },
        handleUserQuestionAction: (message) =>
          handleUserQuestionAction(message),
        handleAgentProposalAction: (message) =>
          this.agentProposalController.handleAction(message),
      },
    });
  }

  private persistStreamSnapshot(streamId: StreamTabId): void {
    const store = this.options.streamSnapshotStore;
    if (!store) return;

    const taskState = this.state.snapshots.getTaskState(streamId);
    const info = buildStreamInfo(this.state, streamId, 'all');
    const restored = this.restoredStreams.get(streamId);
    const snapshot: RestoredStreamSnapshot = {
      streamId,
      label: info?.label ?? restored?.label ?? streamId,
      agent: info?.agent ?? restored?.agent,
      agentCategory:
        info?.agentCategory ??
        restored?.agentCategory ??
        AGENT_CATEGORY.WORKFLOW,
      inputFile: info?.inputFile || restored?.inputFile,
      instruction: taskState?.agentConfig.instruction || restored?.instruction,
      lastKnownStatus:
        StreamStatusService.get(streamId) ??
        restored?.lastKnownStatus ??
        STREAM_STATUS.STOPPED,
      description: info?.description ?? restored?.description,
      executionId: info?.executionId ?? restored?.executionId,
      parentStreamId: info?.parentStreamId ?? restored?.parentStreamId,
      creationTimestamp:
        info?.creationTimestamp ?? restored?.creationTimestamp ?? Date.now(),
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
    this.backend.dispose();
    this.clearDesktopSessionMaps();
    this.workflowFileActions.clearAllBackups();
    void this.state.flush().catch((error: unknown) => {
      this.logger.warn('Failed to flush desktop progress state', {
        data: error instanceof Error ? error : { error },
      });
    });
  }

  private clearDesktopSessionMaps(): void {
    this.agentProposals.clear();
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
  }

  private send(message: ProgressViewOutboundMessage): void {
    this.postToRenderer(message);
  }

  private getStreamExecutionId(streamId: StreamTabId): ExecutionId | undefined {
    return (
      this.state.snapshots.getExecutionId(streamId) ??
      this.state.getStreamHints(streamId).executionId
    );
  }

  private routeToProgress(): void {
    this.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route: 'progress',
    });
  }

  /**
   * Restore a ghost (prior-session) stream's persisted sidecar display from
   * `streamData/` the first time it becomes active — todos / plan / per-run
   * usage / output files — matching what the CLI and extension show on resume.
   * Sent once per stream; only durable data is restored (no liveness).
   */
  private sendRestoredDisplay(streamId: StreamTabId): void {
    if (
      !this.restoredStreams.has(streamId) ||
      this.restoredDisplaySent.has(streamId) ||
      this.restoredDisplayInFlight.has(streamId)
    ) {
      return;
    }
    this.restoredDisplayInFlight.add(streamId);
    void this.state.snapshots
      .read(streamId)
      .then((snap) => {
        if (
          streamId !== this.state.activeStream ||
          !this.restoredStreams.has(streamId)
        ) {
          return;
        }
        // The persisted snapshot is authoritative for a restored stream: send
        // todos/plan verbatim so an intentionally-empty list or null plan CLEARS
        // any stale renderer state instead of being skipped — matching the CLI
        // and extension resume paths (both restore the persisted value as-is).
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
          stream: streamId,
          todos: snap.todos,
        });
        this.send({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_PLAN,
          stream: streamId,
          plan: snap.plan,
        });
        for (const [runId, usage] of Object.entries(snap.runUsage)) {
          this.send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE,
            stream: streamId,
            runId,
            usage,
          });
        }
        if (Object.keys(snap.outputFilesByRound).length > 0) {
          this.send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
            stream: streamId,
            rounds: snap.outputFilesByRound,
          });
        }
        if (Object.keys(snap.missingOutputsByRound).length > 0) {
          this.send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
            stream: streamId,
            rounds: snap.missingOutputsByRound,
          });
        }
        if (Object.keys(snap.compileFailuresByRound).length > 0) {
          this.send({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
            stream: streamId,
            rounds: snap.compileFailuresByRound,
            reset: true,
          });
        }
        this.restoredDisplaySent.add(streamId);
      })
      .catch((error: unknown) => {
        this.logger.warn(`Failed to restore display for ${streamId}`, {
          data: error,
        });
      })
      .finally(() => {
        this.restoredDisplayInFlight.delete(streamId);
      });
  }

  private updateOdysseyActiveFromStore(streamId: StreamTabId): void {
    const odyssey = OdysseyStore.getForStream(streamId);
    this.backend.webviewUpdater.updateOdysseyActive(
      streamId,
      isOdysseyInFlight(odyssey),
      {
        status: odyssey?.status,
        objective: odyssey?.objective,
      },
    );
  }

  private handleProgressEvent<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    bus.emit(event, payload);
    this.updateDesktopRailForProgressEvent(event, payload);
  }

  private updateDesktopRailForProgressEvent<
    K extends keyof ProgressEventPayloads,
  >(event: K, payload: ProgressEventPayloads[K]): void {
    switch (event) {
      case 'setActiveStream': {
        const data = payload as ProgressEventPayloads['setActiveStream'];
        if (!data.streamId) {
          this.state.activeStream = '';
          this.send({
            command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
            activeStream: '',
          });
          return;
        }
        if (data.suppressViewSwitch !== true) {
          this.routeToProgress();
          this.sendRestoredDisplay(data.streamId);
        }
        return;
      }
      case 'setTaskState': {
        const data = payload as ProgressEventPayloads['setTaskState'];
        this.streamLogs.ensureStream(data.streamId);
        this.restoredStreams.delete(data.streamId);
        this.persistStreamSnapshot(data.streamId);
        return;
      }
      case 'updateStreamStatus': {
        const data = payload as ProgressEventPayloads['updateStreamStatus'];
        this.restoredStreams.delete(data.streamId);
        this.persistStreamSnapshot(data.streamId);
        return;
      }
      case 'updateStreamDescription': {
        const data =
          payload as ProgressEventPayloads['updateStreamDescription'];
        this.persistStreamSnapshot(data.streamId);
        return;
      }
      case 'setParentStream': {
        const data = payload as ProgressEventPayloads['setParentStream'];
        this.persistStreamSnapshot(data.childStreamId);
        return;
      }
      default:
        return;
    }
  }

  syncFullView(): void {
    const activeStream = this.backend.webviewUpdater.sendStreamMetadata(
      this.state,
      this.backend.eventHandler.getAllStreamStatuses(),
    );
    this.syncStreamContent(activeStream);
  }

  setActiveStream(streamId: StreamTabId): void {
    if (!this.streamLogs.has(streamId)) {
      return;
    }
    const previous = this.state.activeStream;
    if (previous && previous !== streamId) {
      this.state.releasePreviousActive(previous);
    }
    this.state.activeStream = streamId;
    this.backend.webviewUpdater.sendStreamMetadata(
      this.state,
      this.backend.eventHandler.getAllStreamStatuses(),
    );
    this.backend.webviewUpdater.setActiveStream(streamId);
    this.syncStreamContent(streamId);
  }

  private setAgentFilter(filter: AgentCategoryFilter): void {
    this.state.agentCategoryFilter = filter;
    const activeStream = this.backend.webviewUpdater.sendStreamMetadata(
      this.state,
      this.backend.eventHandler.getAllStreamStatuses(),
    );
    this.syncStreamContent(activeStream);
  }

  async deleteStream(streamId: StreamTabId): Promise<void> {
    if (!this.streamLogs.has(streamId) && !this.restoredStreams.has(streamId)) {
      return;
    }
    this.deletedStreams.add(streamId);
    this.removePersistedStream(streamId);

    // Shared approval cleanup also owns retry/proposal/plan coordinator cleanup.
    cleanupApprovalsForStream(streamId);
    ToolUseFollowUpQueue.release(streamId);

    this.deleteAgentProposalsForStream(streamId);
    this.workflowFileActions.clearStreamBackups(streamId);
    this.restoredDisplaySent.delete(streamId);
    this.restoredDisplayInFlight.delete(streamId);
    await OdysseyStore.forget(streamId);
    await this.state.clearStream(streamId);
    this.send({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: streamId,
    });
    const activeStream = this.backend.webviewUpdater.sendStreamMetadata(
      this.state,
      this.backend.eventHandler.getAllStreamStatuses(),
    );
    this.syncStreamContent(activeStream);
  }

  async deleteAllStreams(): Promise<void> {
    // Shared approval cleanup also owns retry/proposal/plan coordinator cleanup.
    cleanupAllApprovals();
    const streamIds = new Set<StreamTabId>([
      ...this.streamLogs.keys(),
      ...this.restoredStreams.keys(),
    ]);
    for (const streamId of streamIds) {
      this.deletedStreams.add(streamId);
    }
    for (const streamId of streamIds) {
      ToolUseFollowUpQueue.release(streamId);
    }
    await OdysseyStore.forgetMany([...streamIds]);
    // Drop persisted ghosts too: a "delete all" should leave nothing
    // for the next launch to hydrate, otherwise users would see the
    // ghosts come back zombie-style after relaunch.
    this.restoredStreams.clear();
    this.restoredDisplaySent.clear();
    this.restoredDisplayInFlight.clear();
    if (this.options.streamSnapshotStore) {
      void this.options.streamSnapshotStore
        .replaceAll([])
        .catch((error: unknown) => {
          this.logger.warn('Failed to clear stream snapshot store', {
            data: error instanceof Error ? error : { error },
          });
        });
    }

    await this.state.clearAll();
    this.clearDesktopSessionMaps();
    this.workflowFileActions.clearAllBackups();
    this.send({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL });
    this.backend.webviewUpdater.sendStreamMetadata(
      this.state,
      this.backend.eventHandler.getAllStreamStatuses(),
    );
  }

  private syncStreamContent(streamId: StreamTabId | ''): void {
    if (!streamId) {
      this.backend.eventHandler.syncStreamContent('');
      return;
    }

    void this.streamLogs.ensureLoaded(streamId).then(() => {
      if (this.state.activeStream !== streamId) return;
      this.backend.eventHandler.syncStreamContent(streamId, {
        includeActiveState: true,
      });
      this.sendRestoredDisplay(streamId);
    });
  }

  private stopStream(streamId: StreamTabId): void {
    runCoordinatorBridge.clearRetryRequest(streamId);
    executionRegistry.stopAgentStream(streamId, {
      detachActiveChildren: this.options.detachSubagentsOnStop === true,
      runtimeHost: this.runtimeHost,
    });
  }

  async tryResumeStream(streamId: StreamTabId): Promise<boolean> {
    if (
      StreamStatusService.isActiveOrResuming(streamId) ||
      this.resumeAttempts.has(streamId) ||
      this.deletedStreams.has(streamId)
    ) {
      this.logger.debug(
        `Stream ${streamId} cannot be resumed, skipping desktop resume`,
      );
      return false;
    }

    this.resumeAttempts.add(streamId);
    let ownsResumingStatus = false;
    try {
      const resumeState = await this.resolveResumeState(streamId);
      if (!resumeState) {
        await this.options.showInfoMessage?.(
          'No persisted run state was found for this stream. Start a new run instead.',
        );
        return false;
      }

      const { taskState, executionId } = resumeState;
      if (!executionId) {
        await this.options.showInfoMessage?.(
          'This stream has no persisted execution id. Start a new run instead.',
        );
        return false;
      }

      const resume = await retrieveSessionResumeData(
        streamId,
        executionId,
        taskState,
      );
      if (!resume) {
        await this.options.showInfoMessage?.(
          'This run has no resumable session state. Start a new run instead.',
        );
        return false;
      }

      if (resume.type === 'toolUse') {
        ToolUseFollowUpQueue.acquire(streamId);
        ownsResumingStatus = true;
        StreamStatusService.set(streamId, STREAM_STATUS.RESUMING, {
          runtimeHost: this.runtimeHost,
        });
        const queuedFollowUps = ToolUseFollowUpQueue.drainItems(streamId);
        this.runtimeHost.emit('updateQueuedFollowUps', { streamId });
        try {
          await resumeToolUseFromSnapshot(resume.snapshot, this.runtimeHost, {
            setupSession: (session) => {
              for (const item of queuedFollowUps) {
                session.appendFollowUp(item);
              }
            },
          });
        } catch (error) {
          for (const item of queuedFollowUps) {
            ToolUseFollowUpQueue.enqueue(streamId, item);
          }
          if (queuedFollowUps.length > 0) {
            this.runtimeHost.emit('updateQueuedFollowUps', { streamId });
          }
          throw error;
        }
        return true;
      }

      ownsResumingStatus = true;
      StreamStatusService.set(streamId, STREAM_STATUS.RESUMING, {
        runtimeHost: this.runtimeHost,
      });
      await this.runExecution({
        config: resume.agentConfig,
        executionId: resume.executionId,
      });
      return true;
    } catch (error) {
      this.logger.error(`Failed to resume desktop stream ${streamId}`, {
        data: error instanceof Error ? error : { error },
      });
      if (
        ownsResumingStatus &&
        StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING
      ) {
        StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
          runtimeHost: this.runtimeHost,
        });
      }
      await this.options.showErrorMessage?.(
        `Resume failed: ${toErrorMessage(error)}`,
      );
      return false;
    } finally {
      this.resumeAttempts.delete(streamId);
    }
  }

  private async resolveResumeState(
    streamId: StreamTabId,
  ): Promise<ResumeState | undefined> {
    const taskState = this.state.snapshots.getTaskState(streamId);
    const executionId = this.getStreamExecutionId(streamId);
    if (taskState && executionId) return { taskState, executionId };

    const persisted = await this.readPersistedResumeMeta(streamId);

    const restoredTaskState = taskState ?? persisted?.taskState;
    if (!restoredTaskState) return undefined;

    const restoredExecutionId = executionId ?? persisted?.executionId;
    this.state.streamLogs.ensureStream(streamId);
    this.state.updateStreamHints(streamId, {
      agentCategory: restoredTaskState.agentConfig.agentCategory,
    });
    this.state.snapshots.setTaskState(
      streamId,
      restoredTaskState,
      restoredExecutionId,
    );
    if (persisted?.description !== undefined) {
      this.state.snapshots.setDescription(streamId, persisted.description);
    }
    if (persisted?.parentStreamId !== undefined) {
      this.state.snapshots.setParentStream(streamId, persisted.parentStreamId);
    }

    return {
      taskState: restoredTaskState,
      ...(restoredExecutionId && { executionId: restoredExecutionId }),
    };
  }

  private async readPersistedResumeMeta(
    streamId: StreamTabId,
  ): Promise<PersistedResumeMeta | undefined> {
    try {
      // Resume only needs meta.json. Read it directly so this bridge does not
      // create a second StreamSnapshotStore loader/writer for streamData/.
      const meta = await readMeta(new KVStore(streamDataDir(streamId)));
      if (!meta) return undefined;

      const taskState = TaskStateSchema.safeParse(meta.taskState);
      return {
        ...(taskState.success && { taskState: taskState.data }),
        ...(meta.executionId && {
          executionId: meta.executionId as ExecutionId,
        }),
        ...(meta.description !== undefined && {
          description: meta.description,
        }),
        ...(meta.parentStreamId !== undefined && {
          parentStreamId: meta.parentStreamId,
        }),
      };
    } catch (error) {
      this.logger.warn(`Failed to read persisted resume data for ${streamId}`, {
        data: error instanceof Error ? error : { error },
      });
      return undefined;
    }
  }

  private async runNewStream(streamId: StreamTabId): Promise<void> {
    const taskState = this.state.snapshots.getTaskState(streamId);
    if (!taskState) return;

    await this.runExecution({ config: taskState.agentConfig });
  }

  private async sendFollowUp(
    streamId: StreamTabId,
    text: string,
    mediaFiles?: readonly string[],
  ): Promise<void> {
    const result = await sendFollowUp(streamId, text, mediaFiles);
    if (result.status === 'sent' || result.status === 'queued') {
      this.runtimeHost.emit('updateQueuedFollowUps', { streamId });
      return;
    }

    await this.options.showInfoMessage?.(
      'No active session. Start a new agent task to continue.',
    );
  }

  async openFileCompile(filePath: string): Promise<void> {
    if (this.options.openBuildDisplay) {
      await this.options.openBuildDisplay(toFileLocation(filePath));
      return;
    }
    await this.options.showErrorMessage?.(
      'Desktop LaTeX preview is unavailable. Cannot compile and open this file.',
    );
  }

  async runExecution(request: ValidatedExecutionRequest): Promise<void> {
    const { runAgent } = await import('@agent/runtime/runAgent');
    await runAgent(request, {
      runtimeHost: this.runtimeHost,
      openWorkflowOutput: async (result) => {
        const output = result.outputs.at(-1);
        if (!output) return;
        await this.options.openPath?.(output.absolutePath);
      },
    });
  }

  private async compareFiles(
    baseFile: string,
    editedFile: string,
  ): Promise<void> {
    if (!this.options.openDiff) {
      await this.options.showErrorMessage?.(
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
    const [{ getHelperModelName }, { validateExecutionRequest }] =
      await Promise.all([
        import('@agent/runtime/helperModelName'),
        import('@agent/core/execution/executionRequests'),
      ]);
    const validation = validateExecutionRequest({
      config: {
        agent: 'merge',
        model: getHelperModelName(),
        inputFiles: [baseFile],
        editedFile,
      },
    });
    if (!validation.valid) {
      await this.options.showErrorMessage?.(`Merge: ${validation.message}`);
      return;
    }
    await this.runExecution(validation.request);
  }

  private async acceptEditedFile(
    baseFile: string,
    editedFile: string,
  ): Promise<boolean> {
    const baseLocation = pathToLocation(baseFile);
    const editedLocation = pathToLocation(editedFile);
    const target = getAcceptedFileTarget(
      baseLocation,
      editedLocation.absolutePath,
    );
    const { targetLocation, targetFileName, isNewFile } = target;
    const targetExists =
      isNewFile && (await AbsoluteFS.exists(targetLocation.absolutePath));
    const confirmMessage = buildAcceptConfirmMessage(
      target,
      baseFile,
      editedFile,
      targetExists,
    );

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

    await this.options.showInfoMessage?.(
      buildAcceptSuccessMessage(
        targetFileName,
        editedFile,
        !isNewFile || targetExists,
      ),
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
      await this.options.showErrorMessage?.(
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

    const candidates = new Set(
      [
        ...(await this.listWorkspaceFiles('input')),
        ...(await this.listWorkspaceFiles('context')),
      ].map((file) =>
        path.isAbsolute(file) ? file : path.join(workspacePath, file),
      ),
    );

    return openFirstLabelMatch(
      label,
      candidates,
      (file) => readFile(file, 'utf8'),
      async (file) => {
        await this.options.openPath?.(file);
      },
    );
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
}

export function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): DesktopAgentExecution {
  const progress = new DesktopProgressBridge(options.postToRenderer, {
    openPath: options.opener?.openPath,
    openBuildDisplay: options.opener?.openBuildDisplay,
    openDiff: options.diff?.openDiff,
    confirmAcceptFile: options.confirmAcceptFile,
    showInfoMessage: options.showInfoMessage,
    showErrorMessage: options.showErrorMessage,
    streamSnapshotStore: options.streamSnapshotStore,
    progressSnapshotStore: options.progressSnapshotStore,
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
