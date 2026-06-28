import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';

import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { createProgressViewCommandHandlers } from '@controllers/progressView/ProgressViewCommandHandlers';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform, tryPlatform } from '@platform/platform';
import { StreamSnapshotStore } from '@transcript';
import { streamDataDir } from '@transcript/streamDataPaths';
import { readMeta } from '@transcript/streamSnapshotRead';
import type { AgentTrace } from '@agent/trace';
import {
  tryParseRuntimeTaskState,
  type RuntimeTaskState,
  type RuntimeValidatedExecutionRequest,
} from '@agent/runtime/executionRequests';
import { resolveRuntimeBashApproval } from '@agent/runtime/approvalCommands';
import {
  listRuntimeQueuedFollowUpMessages,
  requestRuntimeFollowUp,
} from '@agent/runtime/followUpCommands';
import { getRuntimeGoalControlState } from '@agent/runtime/goalCommands';
import {
  persistRuntimeExternalInquiryDraft,
  resolveRuntimeExternalInquiry,
  resolveRuntimeUserQuestion,
} from '@agent/runtime/humanInputCommands';
import {
  registerRuntimeProgressViewVisibilityProvider,
  type RuntimeProgressViewVisibilityRegistration,
} from '@agent/runtime/progressViewCommands';
import {
  readRuntimeSessionResumeData,
  requestRuntimeToolUseSnapshotResume,
  requestRuntimeWorkflowResume,
} from '@agent/runtime/resumeCommands';
import {
  cancelRuntimeRetry,
  resolveRuntimePlanApproval,
  resolveRuntimeProposal,
} from '@agent/runtime/runCoordinatorCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  releaseRuntimeDeletedStream,
  releaseRuntimeDeletedStreams,
} from '@agent/runtime/streamResourceLifecycle';
import {
  clearAllRuntimeStreamStatuses,
  clearRuntimeStreamStatus,
  getRuntimeStreamStatus,
  getRuntimeStreamStatusSnapshot,
  isRuntimeStreamActiveOrResuming,
  isRuntimeStreamInFlight,
  markRuntimeRunningStreamsStopped,
  requestRuntimeStreamStop,
  setRuntimeStreamStatusSilently,
} from '@agent/runtime/streamControl';
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
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { DiffViewHost, ExternalOpener } from '@hosts/uiHosts';
import { createChannelTrace } from '@logger';
import type { MainViewExecuteMessage } from '@shared/mainView';
import {
  RUN_OUTCOME,
  type AgentProposalPermission,
  type AgentCategoryFilter,
  type MainViewPersistedState,
  type ProgressViewOutboundMessage,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { ProgressBackend } from '@shared/progressView/backend/ProgressBackend';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import { COMMON_COMMANDS } from '@shared/ipc/commonCommands';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
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
  dispose(): void;
}

type ResumeState = {
  taskState: RuntimeTaskState;
  executionId?: ExecutionId;
};

type PersistedResumeMeta = {
  taskState?: RuntimeTaskState;
  executionId?: ExecutionId;
  description?: string;
  parentStreamId?: StreamTabId;
};

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
  private readonly workflowFileActions: ProgressWorkflowFileActionsController;
  private readonly agentProposals = new Map<string, AgentProposalPermission>();
  /**
   * Shown-but-unresolved approval prompts, keyed by `kind:id` and holding the
   * prompt's stream id (may be `''` when the prompt has no stream context).
   * Backs the shared pending-permissions guard against view switches.
   */
  private readonly pendingPermissionStreams = new Map<string, string>();
  private readonly resumeAttempts = new Set<StreamTabId>();
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

  readonly runtimeHost: AgentRuntimeHost;
  readonly progressViewInboundHandlers: ProgressViewInboundHandlerRegistry;

  /**
   * This window's own session. Each desktop BrowserWindow gets a fresh one so
   * its runs, interrupts, coordinator requests, and trace flushers are isolated
   * from other windows and torn down on window close. Cross-window "is this
   * execution running anywhere" checks use the runtime execution query.
   */
  private readonly session: SessionHandle = new SessionHandle();
  /** Detaches the session→toast consumer; called on dispose. */
  private detachResultToast: (() => void) | undefined;
  private readonly visibilityRegistration: RuntimeProgressViewVisibilityRegistration;

  constructor(
    private readonly postToRenderer: (message: unknown) => boolean | void,
    private readonly options: DesktopProgressBridgeOptions = {},
  ) {
    this.visibilityRegistration = registerRuntimeProgressViewVisibilityProvider(
      {
        isViewVisible: () => true,
      },
    );
    this.backend = new ProgressBackend({
      storage: tryPlatform()?.workspaceState ?? new MemoryProgressStorage(),
      snapshots: options.progressSnapshotStore ?? new StreamSnapshotStore(),
      sendMessage: (message) => {
        return this.postToRenderer(message) !== false;
      },
      hasTarget: () => true,
      getStreamControls: getProgressStreamControls,
      getQueuedFollowUps: listRuntimeQueuedFollowUpMessages,
      runtimeSession: {
        retainInterruptStreams: (streams) =>
          this.session.interrupts.retainOnly(new Set(streams)),
        flushPendingTraces: () => this.session.flushPendingTraces(),
      },
      runtimeStatus: {
        getSnapshot: getRuntimeStreamStatusSnapshot,
        setSilently: setRuntimeStreamStatusSilently,
        clear: clearRuntimeStreamStatus,
        clearAll: clearAllRuntimeStreamStatuses,
        isInFlight: isRuntimeStreamInFlight,
        markRunningStopped: markRuntimeRunningStreamsStopped,
      },
      configureUi: ({ webviewUpdater }) => {
        // Track shown-but-unresolved prompts so hasPendingPermissions can
        // keep the active view on a stream awaiting input (the shared
        // ProgressEventHandler guard), mirroring the extension's
        // ApprovalRequestHandler bookkeeping.
        const track = (kind: string, id: string, streamId: string) => {
          this.pendingPermissionStreams.set(`${kind}:${id}`, streamId);
        };
        const release = (kind: string, id: string) => {
          this.pendingPermissionStreams.delete(`${kind}:${id}`);
        };
        return {
          callbacks: {
            // Desktop has no retry panel yet: decline the affordance so the
            // run takes the normal cancel path instead of hanging in WAITING
            // for an answer that can never arrive.
            showRetryRequest: (payload) => {
              cancelRuntimeRetry({
                streamId: payload.streamId,
                session: this.session,
              });
            },
            resolveRetryRequest: () => undefined,
            showToolEditPermission: (payload) => {
              track(
                PERMISSION_KIND.TOOL_EDIT,
                payload.requestId,
                payload.streamId,
              );
              webviewUpdater.showPermission({
                kind: PERMISSION_KIND.TOOL_EDIT,
                data: payload,
              });
            },
            resolveToolEditPermission: (requestId) => {
              release(PERMISSION_KIND.TOOL_EDIT, requestId);
              webviewUpdater.resolvePermission(
                PERMISSION_KIND.TOOL_EDIT,
                requestId,
              );
            },
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
            showBashPermission: (payload) => {
              track(PERMISSION_KIND.BASH, payload.requestId, payload.streamId);
              webviewUpdater.showPermission({
                kind: PERMISSION_KIND.BASH,
                data: payload,
              });
            },
            resolveBashPermission: (requestId) => {
              release(PERMISSION_KIND.BASH, requestId);
              webviewUpdater.resolvePermission(PERMISSION_KIND.BASH, requestId);
            },
            showAgentProposal: (payload) => {
              this.agentProposals.set(payload.proposalId, payload);
              track(
                PERMISSION_KIND.PROPOSAL,
                payload.proposalId,
                payload.streamId,
              );
              webviewUpdater.showPermission({
                kind: PERMISSION_KIND.PROPOSAL,
                data: payload,
              });
            },
            resolveAgentProposal: (proposalId) => {
              this.agentProposals.delete(proposalId);
              release(PERMISSION_KIND.PROPOSAL, proposalId);
              webviewUpdater.resolvePermission(
                PERMISSION_KIND.PROPOSAL,
                proposalId,
              );
            },
            showPlanApproval: (payload) => {
              track(
                PERMISSION_KIND.PLAN_APPROVAL,
                payload.approvalId,
                payload.streamId,
              );
              webviewUpdater.showPermission({
                kind: PERMISSION_KIND.PLAN_APPROVAL,
                data: payload,
              });
            },
            resolvePlanApproval: (approvalId) => {
              release(PERMISSION_KIND.PLAN_APPROVAL, approvalId);
              webviewUpdater.resolvePermission(
                PERMISSION_KIND.PLAN_APPROVAL,
                approvalId,
              );
            },
            showExternalInquiry: (payload) => {
              track(
                PERMISSION_KIND.EXTERNAL_INQUIRY,
                payload.requestId,
                payload.streamId,
              );
              webviewUpdater.showPermission({
                kind: PERMISSION_KIND.EXTERNAL_INQUIRY,
                data: payload,
              });
            },
            resolveExternalInquiry: (requestId) => {
              release(PERMISSION_KIND.EXTERNAL_INQUIRY, requestId);
              webviewUpdater.resolvePermission(
                PERMISSION_KIND.EXTERNAL_INQUIRY,
                requestId,
              );
            },
            showUserQuestion: (payload) => {
              track(
                PERMISSION_KIND.USER_QUESTION,
                payload.requestId,
                payload.streamId,
              );
              webviewUpdater.showPermission({
                kind: PERMISSION_KIND.USER_QUESTION,
                data: payload,
              });
            },
            resolveUserQuestion: (requestId) => {
              release(PERMISSION_KIND.USER_QUESTION, requestId);
              webviewUpdater.resolvePermission(
                PERMISSION_KIND.USER_QUESTION,
                requestId,
              );
            },
          },
          hasPendingPermissions: (streamId) => {
            for (const pending of this.pendingPermissionStreams.values()) {
              // An empty id means the prompt has no stream context; treat it
              // as blocking any switch, matching the extension's
              // ApprovalRequestHandler.hasPendingForStream.
              if (!pending || pending === streamId) return true;
            }
            return false;
          },
        };
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
      runtimeStatus: {
        get: getRuntimeStreamStatus,
        setSilently: setRuntimeStreamStatusSilently,
      },
      goalControls: {
        getControlState: getRuntimeGoalControlState,
      },
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
    this.runtimeHost = {
      emit: (event, payload) => this.handleProgressEvent(event, payload),
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
        resolveRuntimeProposal({
          proposalId,
          result,
          session: this.session,
        });
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
          resolveRuntimeBashApproval(message),
        handlePlanApprovalAction: (message) => {
          resolveRuntimePlanApproval({
            approvalId: message.approvalId,
            result: {
              action: message.action,
              ...(message.action === 'reject' && {
                feedback: message.feedback,
              }),
            },
            session: this.session,
          });
        },
        handleUserQuestionAction: (message) =>
          resolveRuntimeUserQuestion(message),
        handleAgentProposalAction: (message) =>
          this.agentProposalController.handleAction(message),
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
      // External inquiry rides outside the shared registry (as in the
      // extension's ProgressViewMessageHandler): draft persists the open
      // turn, submit/drop settle the durable thread.
      [PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION]: async (data) => {
        if (data.action === 'draft') {
          await persistRuntimeExternalInquiryDraft({
            threadId: data.threadId,
            draft: data.draft ?? null,
          });
          return;
        }
        if (data.action === 'submit') {
          if (data.answer == null || data.answer.length === 0) {
            this.logger.warn(
              'Ignoring external inquiry submit without an answer',
              { data: { threadId: data.threadId } },
            );
            return;
          }
          await resolveRuntimeExternalInquiry({
            action: 'submit',
            threadId: data.threadId,
            answer: data.answer,
            sessionLinks: data.sessionLinks,
            session: this.session,
          });
          return;
        }
        await resolveRuntimeExternalInquiry({
          action: 'drop',
          threadId: data.threadId,
          feedback: data.feedback,
          session: this.session,
        });
      },
    };
  }

  dispose(): void {
    this.visibilityRegistration.dispose();
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

  private clearDesktopSessionMaps(): void {
    this.agentProposals.clear();
    this.pendingPermissionStreams.clear();
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
    if (
      !this.streamLogs.has(streamId) &&
      !this.progressEvents.hasRestoredStream(streamId)
    ) {
      return;
    }
    this.deletedStreams.add(streamId);
    this.progressEvents.onStreamDeleted(streamId);

    await releaseRuntimeDeletedStream({
      streamId,
      session: this.session,
    });

    this.deleteAgentProposalsForStream(streamId);
    this.releasePendingPermissionsForStream(streamId);
    this.workflowFileActions.clearStreamBackups(streamId);
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
    const streamIds = new Set<StreamTabId>([
      ...this.streamLogs.keys(),
      ...this.progressEvents.restoredStreams.keys(),
    ]);
    for (const streamId of streamIds) {
      this.deletedStreams.add(streamId);
    }
    await releaseRuntimeDeletedStreams({
      streamIds,
      approvalScope: 'session',
      session: this.session,
      runtimeHost: this.runtimeHost,
    });
    // Drop persisted ghosts too: a "delete all" should leave nothing
    // for the next launch to hydrate, otherwise users would see the
    // ghosts come back zombie-style after relaunch.
    await this.progressEvents.onAllStreamsDeleted();

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
      this.progressEvents.sendRestoredDisplay(streamId);
    });
  }

  private stopStream(streamId: StreamTabId): void {
    requestRuntimeStreamStop({
      streamId,
      clearRetryRequest: true,
      // Read the live workspace-state value (written by the desktop settings
      // view) at stop time, matching the extension and CLI hosts.
      detachActiveChildren:
        tryPlatform()?.workspaceState.get<boolean>(
          WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
          false,
        ) === true,
      runtimeHost: this.runtimeHost,
      session: this.session,
    });
  }

  async tryResumeStream(streamId: StreamTabId): Promise<boolean> {
    if (
      isRuntimeStreamActiveOrResuming(streamId) ||
      this.resumeAttempts.has(streamId) ||
      this.deletedStreams.has(streamId)
    ) {
      this.logger.debug(
        `Stream ${streamId} cannot be resumed, skipping desktop resume`,
      );
      return false;
    }

    this.resumeAttempts.add(streamId);
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

      const resumeResult = await readRuntimeSessionResumeData({
        streamId,
        executionId,
        taskState,
      });
      switch (resumeResult.status) {
        case 'missing':
          await this.options.showInfoMessage?.(
            'This run has no resumable session state. Start a new run instead.',
          );
          return false;
        case 'failed':
          throw new Error(resumeResult.message, {
            cause: resumeResult.error,
          });
        case 'resumable':
          break;
      }

      const { data: resume } = resumeResult;
      if (resume.type === 'toolUse') {
        return await requestRuntimeToolUseSnapshotResume({
          snapshot: resume.snapshot,
          runtimeHost: this.runtimeHost,
          session: this.session,
        });
      }

      return await requestRuntimeWorkflowResume({
        streamId,
        runtimeHost: this.runtimeHost,
        run: () =>
          this.runExecution({
            config: resume.agentConfig,
            executionId: resume.executionId,
          }),
      });
    } catch (error) {
      this.logger.error(`Failed to resume desktop stream ${streamId}`, {
        data: error instanceof Error ? error : { error },
      });
      await this.options.showErrorMessage?.(
        `Resume failed: ${toErrorMessage(error)}`,
      );
      return false;
    } finally {
      this.resumeAttempts.delete(streamId);
    }
  }

  isResumeInFlight(streamId: StreamTabId): boolean {
    return this.resumeAttempts.has(streamId);
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

      const taskState = tryParseRuntimeTaskState(meta.taskState);
      return {
        ...(taskState && { taskState }),
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
    const executionId = this.getStreamExecutionId(streamId);
    // Resolve the follow-up target against THIS window's session: the run's
    // handle is tracked in `this.session`, but this IPC path runs outside the
    // run ALS, so the module default (currentSession ⇒ defaultSession) would
    // look in the wrong registry and report `no_session` for a live run.
    const result = await requestRuntimeFollowUp({
      streamId,
      text,
      mediaFiles,
      runtimeHost: this.runtimeHost,
      session: this.session,
      ...(executionId !== undefined
        ? { persistedWaitingExecutionId: executionId }
        : {}),
      wakeQueuedStream: true,
    });
    if (result.notice) {
      await this.options.showInfoMessage?.(result.notice.message);
    }
  }

  async openFileCompile(filePath: string): Promise<void> {
    await this.fileActions.openFileCompile(filePath);
  }

  async runExecution(request: RuntimeValidatedExecutionRequest): Promise<void> {
    const { runAgent } = await import('@agent/runtime/runAgent');
    await runAgent(request, {
      runtimeHost: this.runtimeHost,
      session: this.session,
      openWorkflowOutput: async (result) => {
        // Match the extension's auto-open contract: only a completed workflow
        // opens its final output — cancelled runs may carry partial outputs
        // the user did not ask to review — and the config gate applies.
        if (!getConfig<boolean>('texra.agentOutputs.autoOpenFinal', true)) {
          return;
        }
        if (result.outcome !== RUN_OUTCOME.COMPLETED) return;
        const output = result.outputs.at(-1);
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

  private deleteAgentProposalsForStream(streamId: StreamTabId): void {
    for (const [proposalId, proposal] of this.agentProposals.entries()) {
      if (proposal.streamId === streamId) {
        this.agentProposals.delete(proposalId);
      }
    }
  }

  private releasePendingPermissionsForStream(streamId: StreamTabId): void {
    for (const [key, pending] of this.pendingPermissionStreams) {
      if (pending === streamId) {
        this.pendingPermissionStreams.delete(key);
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
  };
}
