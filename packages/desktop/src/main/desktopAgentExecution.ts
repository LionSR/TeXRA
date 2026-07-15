import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';

import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import { ProgressViewHost } from '@controllers/progressView/ProgressViewHost';
import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform, tryPlatform } from '@platform/platform';
import { StreamLogStore, type StreamSnapshotStore } from '@transcript';
import {
  isProgressBackendInteractionEvent,
  type ProgressBackendInteractionPayloads,
} from '@controllers/progressView/backend/events/ProgressInteractionHandler';
import { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import { buildStreamInfo } from '@controllers/progressView/backend/streamInfoUtils';
import {
  buildApprovalRequestHandlerSet,
  createProgressBackendUiConfig,
  replayApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import {
  repairRestartedStreams,
  RESTART_REPAIR_PHASES,
} from '@controllers/progressView/backend/restartRepair';
import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { TaskState } from '@agent/core/state/TaskState';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import {
  isResumeInFlight as isStreamResumeInFlight,
  resolveAndResumeStream,
} from '@agent/runtime/resolveAndResumeStream';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventPayloads,
  AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { resumeToolUseSnapshot } from '@agent/runtime/resumeToolUseSnapshot';
import { selectAutoOpenFinalOutput } from '@agent/runtime/selectAutoOpenFinalOutput';
import {
  getAllActiveExecutionIds,
  SessionHandle,
} from '@agent/runtime/SessionHandle';
import { setProgressViewBridge } from '@agent/runtime/ProgressViewBridge';
import {
  presentFollowUpWakeResult,
  sendFollowUp,
  wakeQueuedFollowUpStream,
} from '@agent/followUp/ToolUseFollowUp';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { isRuntimePresentationEvent } from '@agent/runtime/runtimePresentationEvents';
import {
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import type { MainViewExecuteMessage } from '@shared/mainView';
import {
  STREAM_PHASE,
  type RunOutcome,
  type AgentCategoryFilter,
  type MainViewPersistedState,
  type ProgressViewOutboundMessage,
  type ExecutionId,
  type RequestOpenFilePayload,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS, COMMON_COMMANDS } from '@shared/ipc';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  cleanupUnscopedApprovals,
  releaseStreamResources,
} from '@tools/approval';
import type { RegisteredToolName } from '@tools/registry';
import { DIAGNOSTICS_READ_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';

import { buildDesktopOnboardingSetStateMessage } from '../desktopOnboardingMessages.js';
import { DESKTOP_SHELL_COMMANDS } from '../desktopShellMessages.js';
import {
  createDesktopToolEditApprovalController,
  type DesktopToolEditApprovalController,
} from './desktopToolEditApproval.js';
import {
  createDesktopHostInteractions,
  type DesktopHostInteractions,
} from './desktopHostInteractions.js';
import { DesktopExecutionRebinder } from './desktopExecutionRebinder.js';
import { toLogData } from './desktopLogUtils.js';
import {
  DesktopProgressFileActions,
  type DesktopLatexdiffRunContext,
  type DesktopLatexdiffWorkspaceScan,
} from './desktopProgressFileActions.js';
import {
  createDesktopSessionProgressBridge,
  type DesktopPresentationPayloads,
  type DesktopSessionProgressBridge,
} from './desktopSessionProgressBridge.js';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';
import type { MementoStorage } from '@controllers/progressView/backend/persistence/PersistentMapManager';
import type { DesktopStreamSnapshotStore } from './desktopStreamSnapshot.js';

const DESKTOP_UNAVAILABLE_TOOLS: readonly RegisteredToolName[] = [
  ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
  'inline_comment',
  DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
];
export interface DesktopAgentExecutionOptions {
  postToRenderer(message: unknown): boolean | void;
  host: DesktopAgentExecutionHost;
  /**
   * Optional snapshot store wired by the desktop entrypoint. When
   * provided, the bridge persists a slim snapshot of the rail on each
   * stream change (audit item D / trajectory #19) and surfaces
   * previously-persisted "ghost" streams in the rail at launch.
   */
  streamSnapshotStore?: DesktopStreamSnapshotStore;
  progressSnapshotStore: StreamSnapshotStore;
}

export interface DesktopAgentExecution {
  handleExecute(message: MainViewExecuteMessage): Promise<void>;
  progress: DesktopProgressBridge;
  flush(): Promise<void>;
  dispose(): void;
}

type ResumeState = {
  runState: AgentConfig;
  executionId?: ExecutionId;
  parentStreamId?: StreamTabId;
};

interface DesktopRunExecutionOptions {
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
}

export interface DesktopProgressBridgeOptions {
  transcripts: StreamLogStore;
  logger?: AgentTrace;
  host: DesktopAgentExecutionHost;
  streamSnapshotStore?: DesktopStreamSnapshotStore;
  progressSnapshotStore: StreamSnapshotStore;
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
  private readonly logger: AgentTrace;
  private readonly backend: ProgressBackend;
  private readonly state: ProgressBackend['state'];
  readonly streamLogs: ProgressBackend['state']['streamLogs'];
  private readonly progressHost: ProgressViewHost;
  private readonly agentProposalController: ProgressViewHost['agentProposalController'];
  private readonly workflowFileActions: ProgressViewHost['workflowFileActionsController'];
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
  private readonly hostInteractions: DesktopHostInteractions;
  private readonly fileActions: DesktopProgressFileActions;
  /**
   * Extracted session-progress bridge that owns ghost-stream hydration,
   * stream-snapshot persistence, restored-display sending, session/run facts,
   * and window-local presentation requests.  See #6329.
   */
  private readonly sessionProgress: DesktopSessionProgressBridge;
  private readonly restartRepair: Promise<void>;

  readonly runtimeHost: AgentRuntimeHost;
  readonly progressViewInboundHandlers: ProgressViewInboundHandlerRegistry;

  /**
   * This window's own session. Each desktop BrowserWindow gets a fresh one so
   * its runs, interrupts, pending interactions, and trace flushers are isolated
   * from other windows and torn down on window close. Cross-window "is this
   * execution running anywhere" checks use `getAllActiveExecutionIds()`.
   */
  private readonly session: SessionHandle;
  /** Detaches this window's concrete host interaction implementation. */
  private readonly detachHostInteractions: () => void;
  /** Detaches the session→toast consumer; called on dispose. */
  private detachResultToast: (() => void) | undefined;
  private readonly executionRebinder: DesktopExecutionRebinder;

  constructor(
    private readonly postToRenderer: (message: unknown) => boolean | void,
    private readonly options: DesktopProgressBridgeOptions,
  ) {
    this.logger = options.logger ?? createChannelTrace('DesktopProgressBridge');
    const hostChannel: AgentRuntimeHost = {
      emit: (event, payload) => this.handleInteractionEvent(event, payload),
    };
    this.session = new SessionHandle({
      hostChannel,
      transcripts: options.transcripts,
    });
    this.executionRebinder = new DesktopExecutionRebinder(
      this.session,
      this.logger,
    );
    this.runtimeHost = {
      ...hostChannel,
      interactions: this.session.interactions,
    };
    this.toolEditApprovals = createDesktopToolEditApprovalController({
      runtimeHost: this.runtimeHost,
      session: this.session,
      ui: options.host,
    });
    this.hostInteractions = createDesktopHostInteractions({
      runtimeHost: this.runtimeHost,
      session: this.session,
      getApprovalHandlers: () => this.approvalHandlers,
      getToolEditApprovals: () => this.toolEditApprovals,
    });
    this.detachHostInteractions = this.session.useHostInteractions(
      this.hostInteractions,
    );
    setProgressViewBridge({ isViewVisible: () => true });
    this.backend = new ProgressBackend({
      session: this.session,
      storage: tryPlatform()?.workspaceState ?? new MemoryProgressStorage(),
      snapshots: options.progressSnapshotStore,
      sendMessage: (message) => {
        return this.postToRenderer(message) !== false;
      },
      hasTarget: () => true,
      getStreamControls: (stream) =>
        getProgressStreamControls(stream, this.sessionForStream(stream)),
      deleteStream: (stream) => this.deleteStream(stream),
      getUnsupportedCommands: () =>
        unsupportedCommands(this.progressViewInboundHandlers),
      configureUi: ({ webviewUpdater }) => {
        // The desktop renderer is always attached (no sidebar/editor re-target),
        // so every show/resolve reaches the webview.
        const canSend = () => true;
        this.approvalHandlers = buildApprovalRequestHandlerSet({
          webviewUpdater,
          canSend,
          logger: this.logger,
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
        });
      },
    });
    this.state = this.backend.state;
    this.streamLogs = this.state.streamLogs;
    // Compose the extracted session-progress bridge for ghost-stream hydration,
    // stream-snapshot persistence, restored-display sending, session/run facts,
    // and window-local presentation requests.  See #6329.
    this.sessionProgress = createDesktopSessionProgressBridge({
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
        void this.options.host.showErrorMessage(message);
      },
    });
    const backendSubscription = this.backend.setupEventListeners();
    const detachSessionProgressFacts = this.session.events.subscribe(
      (event) => this.sessionProgress.handleSessionEvent(event),
      { scope: 'session' },
    );
    const detachRunProgressFacts = this.session.events.subscribe(
      (event) => this.sessionProgress.handleSessionEvent(event),
      { scope: 'run', types: ['run.config', 'status'] },
    );
    this.restartRepair = this.repairOrphanedStreamsAfterRestart();
    // Onboarding funnel (PRD: agent-native onboarding): a completed run ends
    // State 1. `AgentRunLifecycle` persists `firstRunDone` BEFORE it emits the
    // terminal `result` event, so by the time this listener fires the funnel
    // derivation will read the up-to-date flag. The setup agent's own run does
    // not flip `firstRunDone` (the lifecycle skips it), but recomputing here is
    // still safe — the derivation is idempotent.
    const unsubscribeResult = this.session.onResult((event) => {
      if (event.outcome === 'completed') {
        this.options.host.onRunCompleted();
      }
    });
    this.unsubscribe = () => {
      detachRunProgressFacts();
      detachSessionProgressFacts();
      backendSubscription.dispose();
      this.sessionProgress.dispose();
      unsubscribeResult();
    };
    // Present terminal-error toasts from this window's run results (the run
    // lifecycle no longer emits them directly) through the same runtimeHost
    // path they used before — scoped to this window's session.
    this.detachResultToast = attachTerminalResultToast(
      this.session,
      this.runtimeHost,
    );
    this.fileActions = new DesktopProgressFileActions(options.host, {
      runExecution: (request) => this.runExecution(request),
      listWorkspaceCandidateFiles: () => this.listWorkspaceCandidateFiles(),
    });
    this.progressHost = this.createProgressViewHost();
    this.workflowFileActions = this.progressHost.workflowFileActionsController;
    this.agentProposalController = this.progressHost.agentProposalController;
    this.progressViewInboundHandlers = this.createProgressViewInboundHandlers();
  }

  private createProgressViewHost(): ProgressViewHost {
    return new ProgressViewHost({
      // Shared run-new path (mirrors the extension wiring). Only
      // `getTaskState` and `executeAgent` matter here: diff/file-operation
      // actions are routed through `workflowFileActions`/`fileActions`, so
      // those deps stay unwired.
      workflowActions: {
        state: {
          getTaskState: (stream) => this.state.snapshots.getTaskState(stream),
          getExecutionId: (stream) => this.getStreamExecutionId(stream),
          getOutputFiles: (stream) =>
            this.state.snapshots.getOutputFiles(stream),
          getKnownWorkspaceOutputPaths: () => new Set(),
        },
        executeAgent: async (request) => {
          const validated = validateExecutionRequest(request);
          if (!validated.valid) {
            this.logger.error('Invalid desktop workflow execution request', {
              data: validated.issue,
            });
            await this.options.host.showErrorMessage(validated.message);
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
      },
      workflowFileActions: {
        state: {
          getActiveStream: () => this.state.activeStream,
          getExecutionId: (stream) => this.getStreamExecutionId(stream),
          getOutputFiles: (stream) =>
            this.state.snapshots.getOutputFiles(stream),
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
            await this.options.host.openPath(directory);
          },
          openLabel: (label) => this.fileActions.findAndOpenLabel(label),
          readFile: (file) => readFile(file, 'utf8'),
          showInfo: async (message) => {
            await this.options.host.showInfoMessage(message);
          },
          showError: async (message) => {
            await this.options.host.showErrorMessage(message);
          },
          logError: (message, error) => {
            this.logger.error(message, {
              data: toLogData(error),
            });
          },
        },
        sendFollowUp: async (stream, text) => {
          await this.sendFollowUp(stream, text);
        },
      },
      agentProposal: {
        getPendingProposal: (proposalId) =>
          this.approvalHandlers.agentProposal.get(proposalId),
        restoreTaskState: async (taskState) => this.restoreTaskState(taskState),
        settleProposal: (proposalId, result) => {
          const resolved = this.session.interactions.resolve(proposalId, {
            kind: 'proposal',
            action: result.action,
            value: result,
          });
          if (!resolved) {
            this.logger.warn(
              `No pending desktop host interaction found for proposal: ${proposalId}`,
            );
          }
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
      },
      commands: {
        lifecycle: {
          setActiveStream: (stream) => this.setActiveStream(stream),
          setAgentFilter: (filter) => this.setAgentFilter(filter),
          deleteStream: (stream) => this.deleteStream(stream),
          deleteAllStreams: () => this.deleteAllStreams(),
          stopStream: (stream) => this.stopStream(stream),
        },
        resumeStream: async (stream) => {
          await this.tryResumeStream(stream);
        },
        followUp: {
          sendFollowUp: ({ stream, text, mediaFiles }) =>
            this.sendFollowUp(stream, text, mediaFiles),
          reportImageSaveError: (image, error) => {
            this.logger.warn(
              `Failed to save pasted follow-up image ${image.fileName}`,
              { data: toLogData(error) },
            );
          },
        },
        bypass: {
          runtimeHost: this.runtimeHost,
          session: this.session,
          sessionForStream: (stream) => this.sessionForStream(stream),
        },
        file: {
          openFile: async (file, line) => {
            await this.options.host.openPath(file, line);
          },
          openFileCompile: (file) => this.openFileCompile(file),
        },
        approval: {
          approvePendingDelegatedWork: (stream, initiatingProposalId) =>
            this.hostInteractions.approvePendingDelegatedWork(
              stream,
              initiatingProposalId,
            ),
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
            void this.session.interactions.resolve(message.requestId, {
              kind: 'bash',
              action: message.action,
              feedback: message.feedback,
            }),
          handlePlanApprovalAction: (message) => {
            this.session.interactions.resolve(message.approvalId, {
              kind: 'plan',
              action: message.action,
              ...(message.action === 'reject' && {
                feedback: message.feedback,
              }),
            });
          },
          handleUserQuestionAction: (message) => {
            this.session.interactions.resolve(message.requestId, {
              kind: 'userQuestion',
              action: message.action,
              value: message.answers,
              feedback: message.feedback,
            });
            return undefined;
          },
        },
        externalInquiry: {
          session: this.session,
        },
      },
    });
  }

  private createProgressViewInboundHandlers(): ProgressViewInboundHandlerRegistry {
    return {
      ...this.progressHost.commandHandlers,
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
        await this.options.host.showInfoMessage(
          `"${labels[data.action]}" requires the VS Code extension.`,
        );
      },
      // These are intercepted in desktopProgressIpc.ts's passThroughCommands
      // (theme/debug-mode/switch-view) or handled before dispatch even
      // reaches this registry (webview-ready), so these entries are never
      // actually invoked — they exist only to satisfy the exhaustive
      // registry type.
      setTheme: () => {},
      setDebugMode: () => {},
      switchView: () => {},
      webviewReady: () => {},
      // Trivially wireable with existing desktop infrastructure.
      showInformationMessage: (data) => {
        void this.options.host.showInfoMessage(data.text);
      },
      restoreProposalConfig: async (data) => {
        await this.agentProposalController.restoreProposalConfig(data.proposal);
      },
      // Mirrors the extension's PROGRESS_VIEW_COMMANDS.RESTORE_STATE handler
      // (`texra.restoreState`): look up the stream's persisted task state and
      // route the renderer to the main view with it. Surfaces a failure the
      // same way the extension's `texra.restoreState` command does when
      // `buildMainViewState` throws on malformed/incompatible persisted data.
      restoreState: async (data) => {
        const taskState = this.state.snapshots.getTaskState(data.stream);
        if (!taskState) return;
        const restored = this.restoreTaskState(taskState);
        if (!restored) {
          await this.options.host.showErrorMessage('Failed to restore state');
        }
      },
      compactResponse: unsupported(
        'Compacting a response is not available in the desktop app yet.',
      ),
      diffStream: unsupported(
        'Viewing a diff for this stream is not available in the desktop app yet.',
      ),
      packStream: unsupported(
        'Packing output files is not available in the desktop app yet.',
      ),
      cleanStream: unsupported(
        'Cleaning output files is not available in the desktop app yet.',
      ),
      retryStreamRequest: unsupported(
        'Retrying with a new API key is not available in the desktop app yet.',
      ),
      cancelRetryRequest: unsupported(
        'Canceling a retry request is not available in the desktop app yet.',
      ),
      useOwnApiKey: unsupported(
        'Using your own API key is not available in the desktop app yet.',
      ),
      polishFollowUp: unsupported(
        'Polishing follow-up text is not available in the desktop app yet.',
      ),
      setupFollowup: unsupported(
        'Follow-up agent selection is not available in the desktop app yet.',
      ),
      runFollowup: unsupported(
        'Follow-up agent selection is not available in the desktop app yet.',
      ),
      getFollowupOptions: unsupported(
        'Follow-up agent selection is not available in the desktop app yet.',
      ),
      startRecording: unsupported(
        'Voice dictation is not available in the desktop app yet.',
      ),
      stopRecording: unsupported(
        'Voice dictation is not available in the desktop app yet.',
      ),
      runCompileFixer: unsupported(
        'The compile fixer is not available in the desktop app yet.',
      ),
      openMemoryView: unsupported(
        'Opening the memory view from a stream is not available in the desktop app yet.',
      ),
      openProfile: unsupported(
        'Opening the profile view from a stream is not available in the desktop app yet.',
      ),
      // Pop-out-to-editor is a VS Code editor-tab concept; the desktop app is
      // a single window.
      popOut: unsupported('Pop-out to editor is a VS Code-only feature.'),
      popBack: unsupported('Pop-out to editor is a VS Code-only feature.'),
    };
  }

  dispose(): void {
    this.detachResultToast?.();
    this.executionRebinder.dispose();
    this.detachHostInteractions();
    this.toolEditApprovals.dispose();
    this.unsubscribe();
    this.backend.dispose();
    this.clearDesktopSessionMaps();
    this.workflowFileActions.clearAllBackups();
    void this.state.flush().catch((error: unknown) => {
      this.logger.warn('Failed to flush desktop progress state', {
        data: toLogData(error),
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
    // Ghost-stream state is owned by the extracted sessionProgress bridge;
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
    for (const [streamId, snapshot] of this.sessionProgress.restoredStreams) {
      if (snapshot.executionId && !executionIds.has(streamId)) {
        executionIds.set(streamId, snapshot.executionId);
      }
    }
    return executionIds;
  }

  private refreshActiveExecutionIds(): {
    activeExecutionIds: Set<string>;
    allExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>;
  } {
    const activeExecutionIds = new Set(getAllActiveExecutionIds());
    const allExecutionIds = this.getRestartRepairExecutionIdMap();
    // Rebind BEFORE forgetting the ghost: a restored stream's executionId
    // being "active" only means some live session still owns it -- possibly
    // a previous window's session, retained post-dispose so headless runs
    // stay visible to process-wide guards (`keepActiveExecutions`, #6329).
    // Without this, forgetting the ghost here (below) leaves the run with no
    // rail entry owner at all: the old window's bridge already stopped
    // forwarding events (disposed), and nothing else ever subscribed this
    // window to them. See #8148.
    this.executionRebinder.rebind(
      activeExecutionIds,
      allExecutionIds,
      this.sessionProgress.restoredStreams,
    );
    this.sessionProgress.forgetActiveRestoredStreams(
      activeExecutionIds,
      allExecutionIds,
    );
    return { activeExecutionIds, allExecutionIds };
  }

  /**
   * Detect persisted waiting streams, then recheck live executions so both
   * primary and degraded restart-repair paths reject resumes won mid-read.
   */
  private async detectRaceGuardedWaitingStreams(
    executionIdMap: ReadonlyMap<StreamTabId, ExecutionId>,
  ): Promise<{
    waitingStreams: Set<StreamTabId>;
    activeExecutionIds: Set<string>;
    allExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>;
  }> {
    const waitingStreams = await detectWaitingStreams(executionIdMap);
    const { activeExecutionIds, allExecutionIds } =
      this.refreshActiveExecutionIds();
    for (const [streamId, executionId] of allExecutionIds) {
      if (activeExecutionIds.has(executionId)) {
        waitingStreams.delete(streamId);
      }
    }
    return { waitingStreams, activeExecutionIds, allExecutionIds };
  }

  private getRestartRepairStreamSet(
    executionIdMap: ReadonlyMap<StreamTabId, ExecutionId>,
    allExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>,
    activeExecutionIds: ReadonlySet<string>,
    waitingStreams: ReadonlySet<StreamTabId>,
  ): Set<StreamTabId> {
    const repairStreams = new Set(waitingStreams);
    for (const streamId of executionIdMap.keys()) {
      const currentStatus = this.session.status.get(streamId);
      if (currentStatus != null && RESTART_REPAIR_PHASES.has(currentStatus)) {
        repairStreams.add(streamId);
      }
    }
    for (const [streamId, snapshot] of this.sessionProgress.restoredStreams) {
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
    status: RunOutcome,
    now: number = Date.now(),
  ): Promise<StreamTabId[]> {
    if (streamIds.length === 0) return [];
    const closedGroups = await this.state.streamLogs.endRunningGroupsForStreams(
      streamIds,
      now,
      status,
    );
    if (closedGroups.length > 0) {
      await this.state.streamLogs.save();
    }
    return closedGroups;
  }

  private async repairOrphanedStreamsAfterRestart(): Promise<void> {
    try {
      this.sessionProgress.hydrateRestoredStreams();
      const { activeExecutionIds, allExecutionIds } =
        this.refreshActiveExecutionIds();
      const executionIdMap = new Map(
        [...allExecutionIds].filter(
          ([, executionId]) => !activeExecutionIds.has(executionId),
        ),
      );
      const {
        waitingStreams,
        activeExecutionIds: repairActiveExecutionIds,
        allExecutionIds: repairAllExecutionIds,
      } = await this.detectRaceGuardedWaitingStreams(executionIdMap);
      const repairExecutionIdMap = new Map(
        [...repairAllExecutionIds].filter(
          ([, executionId]) => !repairActiveExecutionIds.has(executionId),
        ),
      );
      const repairStreams = this.getRestartRepairStreamSet(
        repairExecutionIdMap,
        repairAllExecutionIds,
        repairActiveExecutionIds,
        waitingStreams,
      );
      const repairResult = await repairRestartedStreams({
        streamStatus: this.session.status,
        waitingStreams,
        executionIds: repairAllExecutionIds,
        repairStreams,
        closeRunningGroups: (streamIds, status, now) =>
          this.closeRunningTaskGroupsForStreams(streamIds, status, now),
        statusEmitOptions: {
          trace: this.logger,
        },
        logger: this.logger,
      });
      if (
        repairResult.waitingStreams.length > 0 ||
        repairResult.failedStreams.length > 0 ||
        repairResult.closedWaitingGroups.length > 0 ||
        repairResult.closedFailedGroups.length > 0 ||
        this.sessionProgress.restoredStreams.size > 0
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
      this.sessionProgress.hydrateRestoredStreams();
      const { activeExecutionIds, allExecutionIds } =
        this.refreshActiveExecutionIds();
      let repairExecutionIds = allExecutionIds;
      // The in-memory scan above only catches streams whose CURRENT status
      // already happens to be WAITING. It misses a stream that was RUNNING
      // at crash time but has a valid persisted flow record -- ground truth
      // that only detectWaitingStreams() (KV-store backed) can see. Without
      // this, restart repair would wrongly demote such a
      // stream to FAILED instead of restoring it to WAITING.
      try {
        const executionIdMap = new Map(
          [...allExecutionIds].filter(
            ([, executionId]) => !activeExecutionIds.has(executionId),
          ),
        );
        const {
          waitingStreams: persistedWaitingStreams,
          activeExecutionIds: postDetectActiveExecutionIds,
          allExecutionIds: postDetectAllExecutionIds,
        } = await this.detectRaceGuardedWaitingStreams(executionIdMap);
        for (const streamId of persistedWaitingStreams) {
          waitingStreams.add(streamId);
        }
        repairExecutionIds = postDetectAllExecutionIds;
        // The helper only race-guards its own (persisted-record) result.
        // waitingStreams also carries the pre-existing in-memory-scan
        // entries from above, which predate the KV read and so never got
        // checked against activity that happened during it -- recheck them
        // here too, or an actively-resumed stream could still be handed to
        // closeRunningTaskGroupsForStreams() below.
        for (const [streamId, executionId] of postDetectAllExecutionIds) {
          if (postDetectActiveExecutionIds.has(executionId)) {
            waitingStreams.delete(streamId);
          }
        }
      } catch (detectError) {
        // Keep going with whatever the in-memory scan already found -- a
        // failure here must not block the rest of this already-degraded
        // fallback path.
        this.logger.warn(
          'Failed to consult persisted flow records during desktop restart-repair fallback',
          {
            data: toLogData(detectError),
          },
        );
        // detectRaceGuardedWaitingStreams() throwing only means the
        // KV-store-backed lookup itself failed -- it does not mean no time
        // passed. A stream could still have become active elsewhere while
        // that (failed) await was in flight, so re-fetch active execution
        // ids here too and recheck waitingStreams against them, or an
        // actively-resumed stream could be handed to
        // closeRunningTaskGroupsForStreams() below just because detection
        // happened to fail. This mirrors the recheck the success branch
        // above performs with its own (persisted-record) result, and also
        // re-runs forgetActiveRestoredStreams() so a now-active stream is
        // dropped from repairStreams entirely rather than being marked
        // FAILED.
        const {
          activeExecutionIds: postDetectErrorActiveExecutionIds,
          allExecutionIds: postDetectErrorAllExecutionIds,
        } = this.refreshActiveExecutionIds();
        repairExecutionIds = postDetectErrorAllExecutionIds;
        for (const [streamId, executionId] of postDetectErrorAllExecutionIds) {
          if (postDetectErrorActiveExecutionIds.has(executionId)) {
            waitingStreams.delete(streamId);
          }
        }
      }
      try {
        const fallbackRepairStreams = new Set([
          ...this.sessionProgress.restoredStreams.keys(),
          ...waitingStreams,
        ]);
        const repairResult = await repairRestartedStreams({
          streamStatus: this.session.status,
          waitingStreams,
          executionIds: repairExecutionIds,
          repairStreams: fallbackRepairStreams,
          retryFailedStreams: true,
          closeRunningGroups: (streamIds, status, now) =>
            this.closeRunningTaskGroupsForStreams(streamIds, status, now),
          statusEmitOptions: {
            trace: this.logger,
          },
          logger: this.logger,
        });
        if (
          repairResult.waitingStreams.length > 0 ||
          repairResult.failedStreams.length > 0 ||
          repairResult.closedWaitingGroups.length > 0 ||
          repairResult.closedFailedGroups.length > 0
        ) {
          this.syncFullView();
        }
      } catch (repairError) {
        this.logger.warn(
          'Failed to apply desktop stream repair fallback writes',
          {
            data: toLogData(repairError),
          },
        );
      }
      this.logger.warn('Failed to repair desktop streams after restart', {
        data: toLogData(error),
      });
    }
  }

  private routeToProgress(): void {
    this.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route: 'progress',
    });
  }

  private handleInteractionEvent<K extends AgentRuntimeEvent>(
    event: K,
    payload: AgentRuntimeEventPayloads[K],
  ): void {
    if (isProgressBackendInteractionEvent(event)) {
      this.backend.handleInteractionEvent(
        event,
        payload as ProgressBackendInteractionPayloads[typeof event],
      );
      return;
    }

    if (!isRuntimePresentationEvent(event)) return;

    switch (event) {
      case 'requestEnsureProgressView':
        this.sessionProgress.handlePresentationEvent(
          event,
          payload as DesktopPresentationPayloads[typeof event],
        );
        return;
      case 'requestShowError':
      case 'requestShowInstruction':
        this.sessionProgress.handlePresentationEvent(
          event,
          payload as DesktopPresentationPayloads[typeof event],
        );
        return;
      case 'requestOpenFile': {
        // The extension previews via its LaTeX-Workshop build+view flow
        // (openBuildDisplayIfTex); desktop has no such editor integration,
        // so open the resolved path through the same preview-with-fallback
        // host `openWorkflowOutput` already uses (see runExecution above).
        const data = payload as RequestOpenFilePayload;
        this.options.host
          .openPath(data.location.absolutePath)
          .catch((error) => {
            this.logger.warn('Failed to open requested file on desktop', {
              data: toLogData(error),
            });
          });
        return;
      }
      default:
        return;
    }
  }

  private updateStreamMetadata(): StreamTabId | '' {
    return this.backend.webviewUpdater.sendStreamMetadata(
      this.state,
      this.session.status.getAllStreamStates(),
    );
  }

  syncFullView(): void {
    this.syncStreamContent(this.updateStreamMetadata());
  }

  /**
   * Owns the Progress webview's readiness sequence. Restored streams are
   * folded into `session.status` by `restartRepair`; transcript persistence is
   * already open before this bridge can be constructed. Painting the rail
   * before repair settles would omit restored status from the first paint.
   * Gating the whole sequence here makes the ordering uniform for every
   * `webviewReady` caller.
   */
  async completeWebviewReady(): Promise<void> {
    await this.restartRepair;
    this.syncFullView();
    await replayApprovalRequestHandlers(this.approvalHandlers);
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

  /**
   * Route this window to the progress view and select the given stream.
   * Mirrors the extension's `revealProgressStream` for the desktop Settings
   * Goals panel (issue #7751 FS6) so jumping from a goal entry to its owning
   * run works the same way on both hosts.
   *
   * Resolves category via `buildStreamInfo` (persisted config/hints), not
   * `getStreamState()`'s ephemeral session-only kind, so a goal-owned stream
   * restored from `workspaceState` that hasn't emitted a live fact yet this
   * session still matches the current filter instead of unconditionally
   * resetting it to 'all' (#7851).
   */
  async revealStream(streamId: StreamTabId): Promise<void> {
    await this.restartRepair;
    if (!this.streamLogs.has(streamId)) {
      return;
    }
    const filter = this.state.agentCategoryFilter;
    if (buildStreamInfo(this.state, streamId, filter) === null) {
      this.state.agentCategoryFilter = 'all';
    }
    this.routeToProgress();
    this.setActiveStream(streamId);
  }

  private setAgentFilter(filter: AgentCategoryFilter): void {
    this.state.agentCategoryFilter = filter;
    this.syncStreamContent(this.updateStreamMetadata());
  }

  async deleteStream(streamId: StreamTabId): Promise<void> {
    if (
      !this.streamLogs.has(streamId) &&
      !this.sessionProgress.hasRestoredStream(streamId)
    ) {
      return;
    }
    const ownerSession = this.sessionForStream(streamId);
    this.deletedStreams.add(streamId);

    // Releases approval state (pending approvals, bypass flags, pending
    // requests) and the follow-up queue for this stream. Do this before the
    // deletion event releases the rebound binding that identifies the owner.
    releaseStreamResources(streamId, ownerSession);
    this.sessionProgress.onStreamDeleted(streamId);

    this.releaseApprovalsForStream(streamId);
    this.workflowFileActions.clearStreamBackups(streamId);
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
      ...this.sessionProgress.restoredStreams.keys(),
    ]);
    // Approval cleanup (incl. retry/proposal/plan pending state) is scoped
    // to THIS window's streams via the per-stream helper. Approval state is
    // session-owned, so none of this can touch another window's pending
    // approvals or bypass flags.
    for (const streamId of streamIds) {
      this.deletedStreams.add(streamId);
      releaseStreamResources(streamId, this.sessionForStream(streamId));
    }
    // Catch pending approvals with no concrete stream context (undefined or
    // empty streamId) — the per-stream loop skips them because they do not
    // equal any StreamTabId. Session-scoped, so a sibling window's streamless
    // approval is not rejected.
    cleanupUnscopedApprovals(this.session);
    // Child/subagent interaction requests may be session-owned without a local
    // desktop stream entry, so cancel the owning window's remaining pending
    // interactions after the visible per-stream sweep. This is session-scoped
    // and does not touch sibling windows.
    this.session.interactions.cancel({ cause: 'All streams deleted.' });
    // Drop persisted ghosts too: a "delete all" should leave nothing
    // for the next launch to hydrate, otherwise users would see the
    // ghosts come back zombie-style after relaunch.
    await this.sessionProgress.onAllStreamsDeleted();

    await this.state.clearAll();
    this.clearDesktopSessionMaps();
    this.workflowFileActions.clearAllBackups();
    this.send({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL });
    this.updateStreamMetadata();
  }

  private syncStreamContent(streamId: StreamTabId | ''): void {
    if (!streamId) {
      this.backend.factApplier.syncStreamContent('');
      return;
    }

    void this.streamLogs
      .ensureLoaded(streamId)
      .then(() => {
        if (this.state.activeStream !== streamId) return;
        this.backend.factApplier.syncStreamContent(streamId, {
          includeActiveState: true,
        });
        this.sessionProgress.sendRestoredDisplay(streamId);
      })
      .catch((error: unknown) => {
        this.logger.error(`Failed to load desktop transcript ${streamId}`, {
          data: toLogData(error),
        });
        void this.options.host.showErrorMessage(
          `Transcript load failed: ${toErrorMessage(error)}`,
        );
      });
  }

  private stopStream(streamId: StreamTabId): void {
    const ownerSession = this.sessionForStream(streamId);
    // Kind-scoped: clear only the pending retry panel for this stream.
    ownerSession.interactions.cancel({
      streamId,
      kind: 'retry',
      cause: 'Retry request cleared.',
    });
    ownerSession.executions.stopAgentStream(streamId, {
      detachActiveChildren: detachSubagentsOnStop(),
      runtimeHost: this.runtimeHost,
    });
  }

  private sessionForStream(streamId: StreamTabId): SessionHandle {
    return (
      this.executionRebinder.ownerSessionForStream(streamId) ?? this.session
    );
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
      // Desktop runs write status to this window's session machine, so the
      // resume guards must read the same machine (the process-global default
      // is never populated here).
      streamStatus: this.session.status,
      resolveResumeState: async (id) => {
        const resumeState = await this.resolveResumeState(id);
        if (!resumeState) {
          await this.options.host.showInfoMessage(
            'No persisted run state was found for this stream. Start a new run instead.',
          );
          return undefined;
        }
        if (!resumeState.executionId) {
          await this.options.host.showInfoMessage(
            'This stream has no persisted execution id. Start a new run instead.',
          );
          return undefined;
        }
        return {
          runState: resumeState.runState,
          executionId: resumeState.executionId,
          ...(resumeState.parentStreamId !== undefined && {
            parentStreamId: resumeState.parentStreamId,
          }),
        };
      },
      resumeToolUseSnapshot: (snapshot) =>
        resumeToolUseSnapshot(snapshot, {
          runtimeHost: this.runtimeHost,
          session: this.session,
          runtimeUnavailableTools: DESKTOP_UNAVAILABLE_TOOLS,
          reportFailure: (error) => this.reportResumeFailure(streamId, error),
        }),
      executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
        this.runExecution(
          { config, executionId },
          { modelHandlerCompatibilityKey },
        ),
      reportNoResumableSession: async () => {
        await this.options.host.showInfoMessage(
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
      data: toLogData(error),
    });
    await this.options.host.showErrorMessage(
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

    // Round keys are non-negative integers BY CONSTRUCTION: every write path
    // into StreamSnapshotStore's outputFiles accumulator (both the live
    // addOutputFiles patch path and the persisted-sidecar read path) coerces
    // and rejects round keys through the shared RoundKeySchema
    // (`@shared/schemas/roundIndexed.ts`), so a malformed key can never reach
    // this accumulator. That structural guarantee is what makes the ES2015+
    // spec's ascending-numeric-enumeration-order rule for non-negative
    // integer keys apply here — round and between-round diffs are produced
    // (and opened) in order, matching the VS Code command, with no separate
    // sort needed. A defensive re-sort would only mask a schema regression,
    // not add safety.
    const outputsByRound = this.state.snapshots.getOutputFiles(stream);
    const workspaceScan = this.getLatexdiffWorkspaceScan(stream, editedFile);
    if (Object.keys(outputsByRound).length === 0 && !workspaceScan) {
      return undefined;
    }

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
    let runState = this.state.snapshots.getRunConfig(streamId);
    let executionId = this.getStreamExecutionId(streamId);
    if (runState && executionId) {
      const parentStreamId = this.state.snapshots.getParentStreamId(streamId);
      return {
        runState,
        executionId,
        ...(parentStreamId !== undefined && { parentStreamId }),
      };
    }

    try {
      await this.state.snapshots.preload([streamId]);
    } catch (error) {
      this.logger.warn(`Failed to read persisted resume data for ${streamId}`, {
        data: toLogData(error),
      });
      return undefined;
    }
    runState = this.state.snapshots.getRunConfig(streamId);
    executionId = executionId ?? this.getStreamExecutionId(streamId);
    if (!runState) return undefined;

    this.state.streamLogs.ensureStream(streamId);
    this.state.updateStreamHints(streamId, {
      agentCategory: runState.agentCategory,
    });

    const parentStreamId = this.state.snapshots.getParentStreamId(streamId);
    return {
      runState,
      ...(executionId && { executionId }),
      ...(parentStreamId !== undefined && { parentStreamId }),
    };
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
      this.session.events.emit({
        scope: 'session',
        event: {
          type: 'updateQueuedFollowUps',
          payload: { streamId },
        },
      });
      const wake = await wakeQueuedFollowUpStream(
        streamId,
        result,
        {
          tryResumeStream: (id) => this.tryResumeStream(id),
          isResumeInFlight: (id) => this.isResumeInFlight(id),
        },
        this.session,
      );
      const presentation = presentFollowUpWakeResult(wake);
      if (presentation.severity !== 'none') {
        if (presentation.refreshQueuedFollowUps) {
          this.session.events.emit({
            scope: 'session',
            event: {
              type: 'updateQueuedFollowUps',
              payload: { streamId },
            },
          });
        }
        await this.options.host.showInfoMessage(presentation.message);
      }
      return;
    }

    await this.options.host.showInfoMessage(
      'No active session. Start a new agent task to continue.',
    );
  }

  async openFileCompile(filePath: string): Promise<void> {
    await this.fileActions.openFileCompile(filePath);
  }

  /**
   * Restore a task's setup into the main view: builds the host-neutral
   * persisted-state snapshot and routes the renderer there. Shared by the
   * in-session "restore this proposal" flow (`agentProposal.restoreTaskState`
   * above) and desktop history's "Setup" action (settings IPC), which mirrors
   * the extension's `texra.restoreState` command.
   */
  restoreTaskState(taskState: TaskState): boolean {
    let state: MainViewPersistedState;
    try {
      state = buildMainViewState(taskState);
    } catch (error) {
      this.logger.error('Failed to build main-view state for restore', {
        data: toLogData(error),
      });
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
      modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
      openWorkflowOutput: async (result) => {
        // Gate, outcome check, and final-output selection are shared policy
        // (selectAutoOpenFinalOutput); the desktop host only supplies openPath.
        const output = selectAutoOpenFinalOutput(result);
        if (!output) return;
        await this.options.host.openPath(output.absolutePath);
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

export async function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): Promise<DesktopAgentExecution> {
  const transcripts = await StreamLogStore.open();
  const progress = new DesktopProgressBridge(options.postToRenderer, {
    transcripts,
    host: options.host,
    streamSnapshotStore: options.streamSnapshotStore,
    progressSnapshotStore: options.progressSnapshotStore,
  });

  return {
    progress,
    async handleExecute(message) {
      const preparation = prepareMainViewExecutionRequest(message);
      if (!preparation.valid) {
        await options.host.showErrorMessage(preparation.message);
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
