import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';

import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { createProgressViewCommandHandlers } from '@controllers/progressView/ProgressViewCommandHandlers';
import { ProgressWorkflowActionsController } from '@controllers/progressView/ProgressWorkflowActionsController';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform, tryPlatform } from '@platform/platform';
import { StreamSnapshotStore } from '@transcript';
import { streamDataDir } from '@transcript/streamDataPaths';
import { readMeta } from '@transcript/streamSnapshotRead';
import type { AgentTrace } from '@agent/trace';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import {
  isResumeInFlight as isStreamResumeInFlight,
  resolveAndResumeStream,
} from '@agent/runtime/resolveAndResumeStream';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { resumeToolUseSnapshot } from '@agent/runtime/resumeToolUseSnapshot';
import { selectAutoOpenFinalOutput } from '@agent/runtime/selectAutoOpenFinalOutput';
import {
  getAllActiveExecutionIds,
  SessionHandle,
} from '@agent/runtime/SessionHandle';
import { setProgressViewBridge } from '@agent/runtime/ProgressViewBridge';
import {
  sendFollowUp,
  wakeQueuedFollowUpStream,
} from '@agent/followUp/ToolUseFollowUp';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { toErrorMessage } from '@common/errors';
import {
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { KVStore } from '@common/storage/KVStore';
import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { DiffViewHost, ExternalOpener } from '@hosts/uiHosts';
import { createChannelTrace } from '@logger';
import type { MainViewExecuteMessage } from '@shared/mainView';
import {
  STREAM_PHASE,
  type AgentProposalPermission,
  type AgentCategoryFilter,
  type MainViewPersistedState,
  type ProgressViewOutboundMessage,
  type ExecutionId,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
} from '@shared/schemas';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { ProgressBackend } from '@shared/progressView/backend/ProgressBackend';
import {
  buildApprovalRequestHandlerSet,
  createProgressBackendUiConfig,
  type ApprovalRequestHandlerSet,
} from '@shared/progressView/backend/progressBackendUiConfig';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import { COMMON_COMMANDS } from '@shared/ipc/commonCommands';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import {
  cleanupUnscopedApprovals,
  handleProgressViewBashApprovalAction,
  releaseStreamResources,
} from '@tools/approval';
import type { RegisteredToolName } from '@tools/registry';
import { DIAGNOSTICS_ADD_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import { GoalStore } from '@tools/goal';
import { handleUserQuestionAction } from '@tools/userQuestion';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import { getConfig } from '@utils/config/configUtils';

import { buildDesktopOnboardingSetStateMessage } from '../desktopOnboardingMessages.js';
import { DESKTOP_SHELL_COMMANDS } from '../desktopShellMessages.js';
import {
  createDesktopToolEditApprovalController,
  type DesktopToolEditApprovalController,
} from './desktopToolEditApproval.js';
import {
  DesktopProgressFileActions,
  type DesktopLatexdiffRunContext,
  type DesktopLatexdiffWorkspaceScan,
} from './desktopProgressFileActions.js';
import {
  createDesktopProgressEventBridge,
  type DesktopProgressEventBridge,
} from './desktopProgressEventBridge.js';
import type { DesktopStreamSnapshotStore } from './desktopStreamSnapshot.js';

type DesktopUnavailableTool =
  RegisteredToolName | typeof DIAGNOSTICS_ADD_RUNTIME_CAPABILITY;

const DESKTOP_UNAVAILABLE_TOOLS: readonly DesktopUnavailableTool[] = [
  'list_api_keys',
  'inline_comment',
  DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
];
const RESTART_REPAIR_PHASES: ReadonlySet<StreamPhase> = new Set([
  STREAM_PHASE.RUNNING,
  STREAM_PHASE.WAITING,
]);

export interface DesktopAgentExecutionOptions {
  postToRenderer(message: unknown): boolean | void;
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
  /**
   * Fired once a run in this window's session reaches a completed terminal
   * result. Used to recompute the onboarding funnel after a user's first run
   * (the lifecycle has already persisted `firstRunDone` by the time the
   * terminal `result` event reaches `session.onResult`), so the renderer leaves
   * the setup card without waiting for a restart.
   */
  onRunCompleted?: () => void;
}

export interface DesktopAgentExecution {
  handleExecute(message: MainViewExecuteMessage): Promise<void>;
  progress: DesktopProgressBridge;
  flush(): Promise<void>;
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

interface DesktopRunExecutionOptions {
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
}

export interface DesktopProgressBridgeOptions {
  openPath?: (filePath: string, line?: number) => Promise<void>;
  openBuildDisplay?: BuildDisplayFn;
  openDiff?: DiffViewHost['openDiff'];
  confirmAcceptFile?: (message: string) => Promise<boolean>;
  showInfoMessage?: (message: string) => Promise<void> | void;
  showErrorMessage?: (message: string) => Promise<void> | void;
  streamSnapshotStore?: DesktopStreamSnapshotStore;
  progressSnapshotStore?: StreamSnapshotStore;
  /** See DesktopAgentExecutionOptions.onRunCompleted. */
  onRunCompleted?: () => void;
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
  private readonly workflowActions: ProgressWorkflowActionsController;
  private readonly workflowFileActions: ProgressWorkflowFileActionsController;
  /**
   * Shown-but-unresolved approval prompts, one {@link ApprovalRequestHandler}
   * per kind. These back the shared pending-permissions guard against view
   * switches and the pending-proposal lookup — the same host-agnostic
   * bookkeeping the extension uses, rather than a hand-rolled registry.
   */
  private approvalHandlers!: ApprovalRequestHandlerSet;
  private readonly deletedStreams = new Set<StreamTabId>();
  private readonly unsubscribe: () => void;
  private readonly toolEditApprovals: DesktopToolEditApprovalController;
  private readonly fileActions: DesktopProgressFileActions;
  /**
   * Extracted progress-event bridge that owns ghost-stream hydration,
   * stream-snapshot persistence, restored-display sending, and
   * progress-event → rail-update translation.  See #6329.
   */
  private readonly progressEvents: DesktopProgressEventBridge;
  private readonly restartRepair: Promise<void>;

  readonly runtimeHost: AgentRuntimeHost;
  readonly progressViewInboundHandlers: ProgressViewInboundHandlerRegistry;

  /**
   * This window's own session. Each desktop BrowserWindow gets a fresh one so
   * its runs, interrupts, coordinator requests, and trace flushers are isolated
   * from other windows and torn down on window close. Cross-window "is this
   * execution running anywhere" checks use `getAllActiveExecutionIds()`.
   */
  private readonly session: SessionHandle;
  /** Detaches the session→toast consumer; called on dispose. */
  private detachResultToast: (() => void) | undefined;

  constructor(
    private readonly postToRenderer: (message: unknown) => boolean | void,
    private readonly options: DesktopProgressBridgeOptions = {},
  ) {
    this.runtimeHost = {
      emit: (event, payload) => this.handleProgressEvent(event, payload),
    };
    this.session = new SessionHandle({ hostChannel: this.runtimeHost });
    setProgressViewBridge({ isViewVisible: () => true });
    this.backend = new ProgressBackend({
      session: this.session,
      storage: tryPlatform()?.workspaceState ?? new MemoryProgressStorage(),
      snapshots: options.progressSnapshotStore ?? new StreamSnapshotStore(),
      sendMessage: (message) => {
        return this.postToRenderer(message) !== false;
      },
      hasTarget: () => true,
      getStreamControls: getProgressStreamControls,
      configureUi: ({ webviewUpdater }) => {
        // The desktop renderer is always attached (no sidebar/editor re-target),
        // so every show/resolve reaches the webview.
        const canSend = () => true;
        this.approvalHandlers = buildApprovalRequestHandlerSet({
          webviewUpdater,
          canSend,
          overrides: {
            retry: {
              show: () => undefined,
              resolve: () => undefined,
            },
            agentProposal: {
              show: (p) =>
                webviewUpdater.showPermission({
                  kind: PERMISSION_KIND.PROPOSAL,
                  data: p,
                }),
              resolve: (id) =>
                webviewUpdater.resolvePermission(PERMISSION_KIND.PROPOSAL, id),
            },
          },
        });
        return createProgressBackendUiConfig({
          handlers: this.approvalHandlers,
          webviewUpdater,
          canSend,
          // Desktop has no retry panel: decline the affordance so the run takes
          // the normal cancel path instead of hanging in WAITING for an answer
          // that can never arrive.
          showRetryRequest: (payload) => {
            this.session.coordinators.cancelRetry(payload.streamId);
          },
          resolveRetryRequest: () => undefined,
        });
      },
    });
    this.state = this.backend.state;
    this.streamLogs = this.state.streamLogs;
    const backendSubscription = this.backend.setupEventListeners(bus);
    // Compose the extracted progress-event bridge for ghost-stream hydration,
    // stream-snapshot persistence, restored-display sending, and progress-event
    // → rail-update translation.  See #6329.
    this.progressEvents = createDesktopProgressEventBridge({
      state: this.state,
      streamStatus: this.session.status,
      streamSnapshotStore: options.streamSnapshotStore,
      sendMessage: (message) => this.send(message),
      logger: this.logger,
      getActiveStream: () => this.state.activeStream,
      routeToProgress: () => this.routeToProgress(),
      onGoalStateChanged: (streamId, active, goalOpts) => {
        this.backend.webviewUpdater.updateGoalActive(
          streamId,
          active,
          goalOpts,
        );
      },
      onShowError: (message) => {
        void this.options.showErrorMessage?.(message);
      },
    });
    this.restartRepair = this.repairOrphanedStreamsAfterRestart();
    // Onboarding funnel (PRD: agent-native onboarding): a completed run ends
    // State 1. `AgentRunLifecycle` persists `firstRunDone` BEFORE it emits the
    // terminal `result` event, so by the time this listener fires the funnel
    // derivation will read the up-to-date flag. The setup agent's own run does
    // not flip `firstRunDone` (the lifecycle skips it), but recomputing here is
    // still safe — the derivation is idempotent.
    const unsubscribeResult = this.session.onResult((event) => {
      if (event.outcome === 'completed') {
        this.options.onRunCompleted?.();
      }
    });
    this.unsubscribe = () => {
      backendSubscription.dispose();
      this.progressEvents.dispose();
      unsubscribeResult();
    };
    // Present terminal-error toasts from this window's run results (the run
    // lifecycle no longer emits them directly) through the same runtimeHost
    // path they used before — scoped to this window's session.
    this.detachResultToast = attachTerminalResultToast(
      this.session,
      this.runtimeHost,
    );
    this.toolEditApprovals = createDesktopToolEditApprovalController({
      runtimeHost: this.runtimeHost,
      openPath: options.openPath,
      openBuildDisplay: options.openBuildDisplay,
      openDiff: options.openDiff,
      showErrorMessage: this.options.showErrorMessage,
    });
    this.fileActions = new DesktopProgressFileActions(
      {
        openPath: options.openPath,
        openBuildDisplay: options.openBuildDisplay,
        openDiff: options.openDiff,
        confirmAcceptFile: options.confirmAcceptFile,
        showInfoMessage: options.showInfoMessage,
        showErrorMessage: options.showErrorMessage,
      },
      {
        runtimeHost: this.runtimeHost,
        runExecution: (request) => this.runExecution(request),
        listWorkspaceCandidateFiles: () => this.listWorkspaceCandidateFiles(),
      },
    );
    // Shared run-new path (mirrors the extension wiring). Only `getTaskState`
    // and `executeAgent` matter here: diff/file-operation actions are routed
    // through `workflowFileActions`/`fileActions`, so those deps stay unwired.
    this.workflowActions = new ProgressWorkflowActionsController({
      state: {
        getTaskState: (stream) => this.state.snapshots.getTaskState(stream),
        getExecutionId: (stream) => this.getStreamExecutionId(stream),
        getOutputFiles: (stream) =>
          new Map(this.state.snapshots.getOutputFiles(stream)),
        getKnownWorkspaceOutputPaths: () => new Set(),
      },
      executeAgent: async (request) => {
        const validated = validateExecutionRequest(request);
        if (!validated.valid) {
          this.logger.error('Invalid desktop workflow execution request', {
            data: validated.issue,
          });
          await this.options.showErrorMessage?.(validated.message);
          return;
        }
        await this.runExecution(validated.request);
      },
      runDiff: () => {
        throw new Error('Desktop diff is routed through workflowFileActions');
      },
      runFileOperation: () => {
        throw new Error(
          'Desktop file operations are routed through workflowFileActions',
        );
      },
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
          this.fileActions.compareFiles(baseFile, editedFile),
        acceptEditedFile: (baseFile, editedFile) =>
          this.fileActions.acceptEditedFile(baseFile, editedFile),
        mergeFile: (baseFile, editedFile) =>
          this.fileActions.runMergeFile(baseFile, editedFile),
        latexdiffFile: (baseFile, editedFile) =>
          this.runLatexdiffFile(baseFile, editedFile),
        openDirectory: async (directory) => {
          await this.options.openPath?.(directory);
        },
        openLabel: (label) => this.fileActions.findAndOpenLabel(label),
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
      getPendingProposal: (proposalId) =>
        this.approvalHandlers.agentProposal.get(proposalId),
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
        this.session.coordinators.resolveProposal(proposalId, result);
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
  }

  private createProgressViewInboundHandlers(): ProgressViewInboundHandlerRegistry {
    const sharedHandlers = createProgressViewCommandHandlers({
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
        runNewStream: (stream) => this.workflowActions.runNew(stream),
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
          this.session.coordinators.resolvePlanApproval(message.approvalId, {
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
      externalInquiry: {
        logWarn: (message, context) =>
          this.logger.warn(message, { data: context }),
        sessionContext: { session: this.session },
      },
    });
    return {
      ...sharedHandlers,
      // Getting-started actions from the progress empty-state. openWalkthrough
      // has a desktop equivalent; the remaining four actions are VS Code-only.
      [PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION]: async (data) => {
        if (data.action === 'openWalkthrough') {
          this.postToRenderer(buildDesktopOnboardingSetStateMessage(true));
          return;
        }
        const labels: Record<typeof data.action, string> = {
          runSetup: 'Run setup assistant',
          createSampleProject: 'Create sample project',
          cloneOverleaf: 'Import from Overleaf',
          downloadArxiv: 'Import from arXiv',
        };
        await this.options.showInfoMessage?.(
          `"${labels[data.action]}" requires the VS Code extension.`,
        );
      },
    };
  }

  dispose(): void {
    this.detachResultToast?.();
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
    // Tear down this window's session last. In-flight runs are allowed to keep
    // executing headless on macOS after the window closes, but their execution
    // ids must remain visible to process-wide history guards until they settle.
    this.session.dispose({ keepActiveExecutions: true });
  }

  async flush(): Promise<void> {
    await this.state.flush();
  }

  private clearDesktopSessionMaps(): void {
    // Drop every pending approval (and proposal payload) without notifying the
    // webview — the "delete all"/teardown sweep already settles the underlying
    // approvals through releaseStreamResources/cleanup helpers.
    for (const handler of Object.values(this.approvalHandlers)) {
      handler.clear();
    }
    // Ghost-stream state is owned by the extracted progressEvents bridge;
    // onAllStreamsDeleted handles clearing it.
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

  private getRestartRepairExecutionIdMap(): ReadonlyMap<
    StreamTabId,
    ExecutionId
  > {
    const executionIds = new Map(this.state.snapshots.getExecutionIdMap());
    for (const [streamId, snapshot] of this.progressEvents.restoredStreams) {
      if (snapshot.executionId && !executionIds.has(streamId)) {
        executionIds.set(streamId, snapshot.executionId);
      }
    }
    return executionIds;
  }

  private resetRestartRepairStreamStatuses(
    repairStreams: ReadonlySet<StreamTabId>,
    waitingStreams: ReadonlySet<StreamTabId>,
  ): StreamTabId[] {
    const affectedStreams: StreamTabId[] = [];
    const statusEmitOptions = {
      runtimeHost: this.runtimeHost,
      trace: this.logger,
    };
    for (const streamId of repairStreams) {
      const currentStatus = this.session.status.get(streamId);
      if (!currentStatus || !RESTART_REPAIR_PHASES.has(currentStatus)) {
        continue;
      }
      if (waitingStreams.has(streamId)) {
        this.session.status.transition(
          streamId,
          STREAM_PHASE.WAITING,
          'restart-repair',
          statusEmitOptions,
        );
        this.logger.debug(
          `Stream ${streamId} restored to WAITING after reload`,
        );
        continue;
      }
      let markedFailed = this.session.status.transition(
        streamId,
        STREAM_PHASE.FAILED,
        'restart-repair',
        statusEmitOptions,
      );
      if (!markedFailed && currentStatus === STREAM_PHASE.WAITING) {
        markedFailed =
          this.session.status.transition(
            streamId,
            STREAM_PHASE.RUNNING,
            'resume',
            statusEmitOptions,
          ) &&
          this.session.status.transition(
            streamId,
            STREAM_PHASE.FAILED,
            'lifecycle',
            statusEmitOptions,
          );
      }
      if (markedFailed) {
        affectedStreams.push(streamId);
        this.logger.debug(
          `Stream ${streamId} set to FAILED during desktop restart recovery`,
        );
      } else {
        this.logger.warn(
          `Failed to repair stream ${streamId} during desktop restart recovery`,
        );
      }
    }
    return affectedStreams;
  }

  private getRestartRepairStreamSet(
    executionIdMap: ReadonlyMap<StreamTabId, ExecutionId>,
    allExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>,
    activeExecutionIds: ReadonlySet<string>,
  ): Set<StreamTabId> {
    const repairStreams = new Set(executionIdMap.keys());
    for (const [streamId, snapshot] of this.progressEvents.restoredStreams) {
      const executionId = snapshot.executionId ?? allExecutionIds.get(streamId);
      if (executionId && activeExecutionIds.has(executionId)) {
        continue;
      }
      const currentStatus = this.session.status.get(streamId);
      if (
        RESTART_REPAIR_PHASES.has(snapshot.lastKnownStatus) ||
        (currentStatus != null && RESTART_REPAIR_PHASES.has(currentStatus))
      ) {
        repairStreams.add(streamId);
      }
    }
    return repairStreams;
  }

  private async closeRunningTaskGroupsForStreams(
    streamIds: readonly StreamTabId[],
  ): Promise<StreamTabId[]> {
    if (streamIds.length === 0) return [];
    const closedGroups = await this.state.streamLogs.endRunningGroupsForStreams(
      streamIds,
      Date.now(),
    );
    if (closedGroups.length > 0) {
      await this.state.streamLogs.save();
    }
    return closedGroups;
  }

  private async repairOrphanedStreamsAfterRestart(): Promise<void> {
    try {
      await this.state.streamLogs.load();
      this.progressEvents.hydrateRestoredStreams();
      const activeExecutionIds = new Set(getAllActiveExecutionIds());
      const allExecutionIds = this.getRestartRepairExecutionIdMap();
      this.progressEvents.forgetActiveRestoredStreams(
        activeExecutionIds,
        allExecutionIds,
      );
      const executionIdMap = new Map(
        [...allExecutionIds].filter(
          ([, executionId]) => !activeExecutionIds.has(executionId),
        ),
      );
      const waitingStreams = await detectWaitingStreams(executionIdMap);
      const repairActiveExecutionIds = new Set(getAllActiveExecutionIds());
      const repairAllExecutionIds = this.getRestartRepairExecutionIdMap();
      this.progressEvents.forgetActiveRestoredStreams(
        repairActiveExecutionIds,
        repairAllExecutionIds,
      );
      for (const [streamId, executionId] of repairAllExecutionIds) {
        if (repairActiveExecutionIds.has(executionId)) {
          waitingStreams.delete(streamId);
        }
      }
      const repairExecutionIdMap = new Map(
        [...repairAllExecutionIds].filter(
          ([, executionId]) => !repairActiveExecutionIds.has(executionId),
        ),
      );
      const repairStreams = this.getRestartRepairStreamSet(
        repairExecutionIdMap,
        repairAllExecutionIds,
        repairActiveExecutionIds,
      );
      const affectedStreams = this.resetRestartRepairStreamStatuses(
        repairStreams,
        waitingStreams,
      );
      const closeGroupStreams = new Set([
        ...affectedStreams,
        ...waitingStreams,
      ]);
      const closedGroups = await this.closeRunningTaskGroupsForStreams([
        ...closeGroupStreams,
      ]);
      if (
        waitingStreams.size > 0 ||
        affectedStreams.length > 0 ||
        closedGroups.length > 0 ||
        this.progressEvents.restoredStreams.size > 0
      ) {
        this.syncFullView();
      }
    } catch (error) {
      const waitingStreams = new Set<StreamTabId>();
      for (const [streamId, status] of this.session.status.entries()) {
        if (status === STREAM_PHASE.WAITING) {
          waitingStreams.add(streamId);
        }
      }
      this.progressEvents.hydrateRestoredStreams();
      const activeExecutionIds = new Set(getAllActiveExecutionIds());
      const allExecutionIds = this.getRestartRepairExecutionIdMap();
      this.progressEvents.forgetActiveRestoredStreams(
        activeExecutionIds,
        allExecutionIds,
      );
      const affectedStreams = this.resetRestartRepairStreamStatuses(
        new Set(this.progressEvents.restoredStreams.keys()),
        waitingStreams,
      );
      const closeGroupStreams = new Set([
        ...affectedStreams,
        ...waitingStreams,
      ]);
      if (closeGroupStreams.size > 0) {
        try {
          await this.closeRunningTaskGroupsForStreams([...closeGroupStreams]);
        } catch (groupError) {
          this.logger.warn(
            'Failed to close desktop stream groups after repair failure',
            {
              data:
                groupError instanceof Error
                  ? groupError
                  : { error: groupError },
            },
          );
        }
      }
      if (affectedStreams.length > 0 || waitingStreams.size > 0) {
        this.syncFullView();
      }
      this.logger.warn('Failed to repair desktop streams after restart', {
        data: error instanceof Error ? error : { error },
      });
    }
  }

  private routeToProgress(): void {
    this.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route: 'progress',
    });
  }

  private handleProgressEvent<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    bus.emit(event, payload);
    this.progressEvents.onProgressEvent(event, payload);
  }

  private streamStatusSnapshot(): Map<StreamTabId, StreamPhase> {
    return this.session.status.getAll();
  }

  private streamSubstateSnapshot(): Map<StreamTabId, StreamSubstate> {
    return this.session.status.getAllSubstates();
  }

  private updateStreamMetadata(): StreamTabId | '' {
    return this.backend.webviewUpdater.sendStreamMetadata(
      this.state,
      this.streamStatusSnapshot(),
      undefined,
      this.streamSubstateSnapshot(),
    );
  }

  syncFullView(): void {
    this.syncStreamContent(this.updateStreamMetadata());
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
    this.updateStreamMetadata();
    this.backend.webviewUpdater.setActiveStream(streamId);
    this.syncStreamContent(streamId);
  }

  private setAgentFilter(filter: AgentCategoryFilter): void {
    this.state.agentCategoryFilter = filter;
    this.syncStreamContent(this.updateStreamMetadata());
  }

  async deleteStream(streamId: StreamTabId): Promise<void> {
    if (
      !this.streamLogs.has(streamId) &&
      !this.progressEvents.hasRestoredStream(streamId)
    ) {
      return;
    }
    this.deletedStreams.add(streamId);
    this.progressEvents.onStreamDeleted(streamId);

    // Releases approval state (pending approvals, bypass flags, coordinator
    // requests) and the follow-up queue for this stream.
    releaseStreamResources(streamId, this.session);

    this.releaseApprovalsForStream(streamId);
    this.workflowFileActions.clearStreamBackups(streamId);
    await GoalStore.forget(streamId);
    await this.state.clearStream(streamId);
    this.send({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream: streamId,
    });
    this.syncStreamContent(this.updateStreamMetadata());
  }

  async deleteAllStreams(): Promise<void> {
    const streamIds = new Set<StreamTabId>([
      ...this.streamLogs.keys(),
      ...this.progressEvents.restoredStreams.keys(),
    ]);
    // Approval cleanup (incl. retry/proposal/plan coordinator state) is scoped
    // to THIS window's streams via the per-stream helper, NOT the process-wide
    // `cleanupAllApprovals` reset — so one window's "delete all" can't wipe
    // another window's pending approvals (the approval controllers are
    // process-global and streamId-keyed; the coordinator half is session-owned).
    for (const streamId of streamIds) {
      this.deletedStreams.add(streamId);
      releaseStreamResources(streamId, this.session);
    }
    // Catch pending approvals with no concrete stream context (undefined or
    // empty streamId) — the per-stream loop skips them because they do not
    // equal any StreamTabId. Scope this to THIS window's runtime host so a
    // sibling window's streamless approval is not rejected.
    cleanupUnscopedApprovals(this.runtimeHost);
    // Child/subagent coordinator requests may be session-owned without a local
    // desktop stream entry, so clear the owning window's coordinator bridge
    // after the visible per-stream sweep. This is session-scoped and does not
    // touch sibling windows.
    this.session.coordinators.cleanupAllRequests();
    await GoalStore.forgetMany([...streamIds]);
    // Drop persisted ghosts too: a "delete all" should leave nothing
    // for the next launch to hydrate, otherwise users would see the
    // ghosts come back zombie-style after relaunch.
    await this.progressEvents.onAllStreamsDeleted();

    await this.state.clearAll();
    this.clearDesktopSessionMaps();
    this.workflowFileActions.clearAllBackups();
    this.send({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL });
    this.updateStreamMetadata();
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
      this.progressEvents.sendRestoredDisplay(streamId);
    });
  }

  private stopStream(streamId: StreamTabId): void {
    this.session.coordinators.clearRetryRequest(streamId);
    this.session.executions.stopAgentStream(streamId, {
      detachActiveChildren: detachSubagentsOnStop(),
      runtimeHost: this.runtimeHost,
    });
  }

  async tryResumeStream(streamId: StreamTabId): Promise<boolean> {
    await this.restartRepair;
    // Desktop-only pre-check: a stream deleted in this window must never be
    // resurrected, even if its persisted meta.json survives on disk. The shared
    // orchestrator owns the active/resuming + in-flight guards.
    if (this.deletedStreams.has(streamId)) {
      this.logger.debug(
        `Stream ${streamId} cannot be resumed, skipping desktop resume`,
      );
      return false;
    }

    return resolveAndResumeStream(streamId, {
      runtimeHost: this.runtimeHost,
      resolveResumeState: async (id) => {
        const resumeState = await this.resolveResumeState(id);
        if (!resumeState) {
          await this.options.showInfoMessage?.(
            'No persisted run state was found for this stream. Start a new run instead.',
          );
          return undefined;
        }
        if (!resumeState.executionId) {
          await this.options.showInfoMessage?.(
            'This stream has no persisted execution id. Start a new run instead.',
          );
          return undefined;
        }
        return {
          taskState: resumeState.taskState,
          executionId: resumeState.executionId,
        };
      },
      resumeToolUseSnapshot: (snapshot) =>
        resumeToolUseSnapshot(snapshot, {
          runtimeHost: this.runtimeHost,
          session: this.session,
          runtimeUnavailableTools: DESKTOP_UNAVAILABLE_TOOLS,
          toolEditApprovalHandler: (approvalRequest) =>
            this.toolEditApprovals.requestApproval(approvalRequest),
          reportFailure: (error) => this.reportResumeFailure(streamId, error),
        }),
      executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
        this.runExecution(
          { config, executionId },
          { modelHandlerCompatibilityKey },
        ),
      reportNoResumableSession: async () => {
        await this.options.showInfoMessage?.(
          'This run has no resumable session state. Start a new run instead.',
        );
      },
      reportFailure: async (id, error) => {
        await this.reportResumeFailure(id, error);
      },
    });
  }

  isResumeInFlight(streamId: StreamTabId): boolean {
    return isStreamResumeInFlight(streamId);
  }

  private async reportResumeFailure(
    streamId: StreamTabId,
    error: unknown,
  ): Promise<void> {
    this.logger.error(`Failed to resume desktop stream ${streamId}`, {
      data: error instanceof Error ? error : { error },
    });
    await this.options.showErrorMessage?.(
      `Resume failed: ${toErrorMessage(error)}`,
    );
  }

  private async runLatexdiffFile(
    baseFile: string,
    editedFile: string,
  ): Promise<void> {
    const context = this.getActiveLatexdiffRunContext(editedFile);
    if (!context) {
      await this.fileActions.runLatexdiffFile(baseFile, editedFile);
      return;
    }

    await this.fileActions.runLatexdiffForRun(baseFile, editedFile, context);
  }

  private getActiveLatexdiffRunContext(
    editedFile: string,
  ): DesktopLatexdiffRunContext | undefined {
    const stream = this.state.activeStream;
    if (!stream) return undefined;

    // Sort rounds ascending so round and between-round diffs are produced (and
    // opened) in order, matching the VS Code command.
    const outputsByRound = new Map(
      [...this.state.snapshots.getOutputFiles(stream)].sort(
        (a, b) => a[0] - b[0],
      ),
    );
    const workspaceScan = this.getLatexdiffWorkspaceScan(stream, editedFile);
    if (outputsByRound.size === 0 && !workspaceScan) return undefined;

    const executionId = this.getStreamExecutionId(stream);
    return {
      outputsByRound,
      ...(executionId && { executionId }),
      ...(workspaceScan && { workspaceScan }),
    };
  }

  private getLatexdiffWorkspaceScan(
    stream: StreamTabId,
    editedFile: string,
  ): DesktopLatexdiffWorkspaceScan | undefined {
    const taskState = this.state.snapshots.getTaskState(stream);
    if (!taskState) return undefined;

    const { agent, model, inputFiles, outputFiles } = taskState.agentConfig;
    const inputFile = inputFiles.at(0) ?? editedFile;
    // Thread the run's output files so multi-document runs resolved via the
    // run-dir / workspace scan diff every output, not just the primary input.
    return {
      agent,
      model,
      inputFile,
      ...(outputFiles && outputFiles.length > 0 ? { outputFiles } : {}),
    };
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

  private async sendFollowUp(
    streamId: StreamTabId,
    text: string,
    mediaFiles?: readonly string[],
  ): Promise<void> {
    await this.restartRepair;
    // Resolve the follow-up target against THIS window's session: the run's
    // handle is tracked in `this.session`, but this IPC path runs outside the
    // run ALS, so the module default (currentSession ⇒ defaultSession) would
    // look in the wrong registry and report `no_session` for a live run.
    const result = await sendFollowUp(
      streamId,
      text,
      mediaFiles,
      undefined,
      this.session,
    );
    if (result.status === 'sent' || result.status === 'queued') {
      this.runtimeHost.emit('updateQueuedFollowUps', { streamId });
      const wake = await wakeQueuedFollowUpStream(streamId, result, {
        tryResumeStream: (id) => this.tryResumeStream(id),
        isResumeInFlight: (id) => this.isResumeInFlight(id),
      });
      if (wake.kind === 'dropped') {
        this.runtimeHost.emit('updateQueuedFollowUps', { streamId });
        await this.options.showInfoMessage?.(
          'Message dropped because no session was available to receive it. Start a new agent task to continue.',
        );
      } else if (wake.kind === 'queued_resume_failed') {
        await this.options.showInfoMessage?.(
          'Message queued. Auto-resume failed; start a new agent task to continue.',
        );
      }
      return;
    }

    await this.options.showInfoMessage?.(
      'No active session. Start a new agent task to continue.',
    );
  }

  async openFileCompile(filePath: string): Promise<void> {
    await this.fileActions.openFileCompile(filePath);
  }

  async runExecution(
    request: ValidatedExecutionRequest,
    options: DesktopRunExecutionOptions = {},
  ): Promise<void> {
    await this.restartRepair;
    const { runAgent } = await import('@agent/runtime/runAgent');
    await runAgent(request, {
      runtimeHost: this.runtimeHost,
      session: this.session,
      runtimeUnavailableTools: DESKTOP_UNAVAILABLE_TOOLS,
      toolEditApprovalHandler: (approvalRequest) =>
        this.toolEditApprovals.requestApproval(approvalRequest),
      modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
      openWorkflowOutput: async (result) => {
        // Gate, outcome check, and final-output selection are shared policy
        // (selectAutoOpenFinalOutput); the desktop host only supplies openPath.
        const output = selectAutoOpenFinalOutput(result);
        if (!output) return;
        await this.options.openPath?.(output.absolutePath);
      },
    });
  }

  /**
   * Absolute paths of workspace input + context files, used by label search.
   * Empty when no workspace is open so the caller resolves no matches.
   */
  private async listWorkspaceCandidateFiles(): Promise<string[]> {
    const workspacePath = platform().workspace.getWorkspacePath();
    if (!workspacePath) return [];

    const files = [
      ...(await this.listWorkspaceFiles('input')),
      ...(await this.listWorkspaceFiles('context')),
    ];
    return files.map((file) =>
      path.isAbsolute(file) ? file : path.join(workspacePath, file),
    );
  }

  /**
   * Drop every pending approval (incl. proposal payloads) tied to a deleted
   * stream from the pending guard. The underlying approvals are settled by
   * releaseStreamResources; this only clears prompts that never receive a
   * resolve event (e.g. durable external inquiries), keeping the guard from
   * blocking switches on a stream that no longer exists.
   */
  private releaseApprovalsForStream(streamId: StreamTabId): void {
    for (const handler of Object.values(this.approvalHandlers)) {
      handler.releaseForStream(streamId);
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
    onRunCompleted: options.onRunCompleted,
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
    flush() {
      return progress.flush();
    },
  };
}
