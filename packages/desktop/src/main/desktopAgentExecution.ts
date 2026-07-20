import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentTrace } from '@agent/trace';

import { createChannelTrace } from '@agent/trace';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import type { TaskState } from '@agent/core/state/TaskState';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventPayloads,
  AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  presentFollowUpWakeResult,
  sendFollowUp,
  wakeQueuedFollowUpStream,
} from '@agent/followUp/ToolUseFollowUp';
import { isRuntimePresentationEvent } from '@agent/runtime/runtimePresentationEvents';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import {
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import {
  repairRestartedStreams,
  RestartRepairRetryScheduler,
  type RestartRepairResult,
} from '@controllers/progressView/backend/restartRepair';
import { replayApprovalRequestHandlers } from '@controllers/progressView/backend/progressBackendUiConfig';
import { buildStreamInfo } from '@controllers/progressView/backend/streamInfoUtils';
import { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import {
  isProgressBackendInteractionEvent,
  type ProgressBackendInteractionPayloads,
} from '@controllers/progressView/backend/events/ProgressInteractionHandler';
import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import { ProgressViewHost } from '@controllers/progressView/ProgressViewHost';
import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import type { SessionStores } from '@controllers/progressView/backend/state/SessionStores';
import { platform } from '@platform/platform';
import { PROGRESS_VIEW_COMMANDS, COMMON_COMMANDS } from '@shared/ipc';
import {
  type RunOutcome,
  type AgentCategoryFilter,
  type MainViewPersistedState,
  type ProgressViewOutboundMessage,
  type ExecutionId,
  type RequestOpenFilePayload,
  type StreamTabId,
} from '@shared/schemas';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  formatActiveStreamRetention,
  formatStreamDeletionRetention,
} from '@shared/copy/executionHistory';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import { cleanupUnscopedApprovals } from '@tools/approval';
import type { StreamSnapshotStore } from '@transcript';
import { getConfig } from '@utils/config/configUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
import { toLogData } from './desktopLogUtils.js';
import {
  DesktopProgressFileActions,
  type DesktopLatexdiffRunContext,
  type DesktopLatexdiffWorkspaceScan,
} from './desktopProgressFileActions.js';
import {
  launchDesktopAgent,
  type DesktopAgentLaunchOptions as DesktopRunExecutionOptions,
} from './desktopAgentLaunch.js';
import type { DesktopProgressInboundHandlerRegistry } from './desktopProgressIpc.js';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';

export interface DesktopAgentExecutionOptions {
  postToRenderer(message: unknown): boolean | void;
  host: DesktopAgentExecutionHost;
  session: SessionHandle;
  progressSnapshotStore: StreamSnapshotStore;
  sessionStores: SessionStores;
  /** Aborts construction and detaches presentation when its window closes. */
  presentationSignal?: AbortSignal;
}

export interface DesktopProgressBridgeOptions {
  session: SessionHandle;
  sessionStores: SessionStores;
  logger?: AgentTrace;
  host: DesktopAgentExecutionHost;
  progressSnapshotStore: StreamSnapshotStore;
  wakeQueuedFollowUpStream?: typeof wakeQueuedFollowUpStream;
}

async function wakeDesktopFollowUp(
  streamId: StreamTabId,
  result: Extract<
    Awaited<ReturnType<typeof sendFollowUp>>,
    { status: 'sent' | 'queued' }
  >,
  session: SessionHandle,
  wakeFollowUpStream: typeof wakeQueuedFollowUpStream = wakeQueuedFollowUpStream,
): Promise<void> {
  // This continuation deliberately accepts only the process SessionHandle.
  // It may outlive a window, so it must not capture a bridge or BrowserWindow
  // presentation. Its important failure notice explicitly survives a detached
  // interval and is delivered once when the next presentation attaches.
  const wake = await wakeFollowUpStream(
    streamId,
    result,
    platform().agentResume,
    session,
  );
  const presentation = presentFollowUpWakeResult(wake);
  if (presentation.severity === 'none') return;
  if (presentation.refreshQueuedFollowUps) {
    session.events.emit({
      scope: 'session',
      event: {
        type: 'updateQueuedFollowUps',
        payload: { streamId },
      },
    });
  }
  await session.interactions.showInfoMessage(presentation.message, {
    replayWhenAttached: true,
  });
}

export class DesktopProgressBridge {
  private readonly logger: AgentTrace;
  private readonly backend: ProgressBackend;
  private readonly state: ProgressBackend['state'];
  readonly streamLogs: ProgressBackend['state']['streamLogs'];
  private progressHost!: ProgressViewHost;
  private agentProposalController!: ProgressViewHost['agentProposalController'];
  private workflowFileActions!: ProgressViewHost['workflowFileActionsController'];
  /**
   * Pending approval prompts, one {@link ApprovalRequestHandler}
   * per kind. These back the shared pending-permissions guard against view
   * switches and the pending-proposal lookup — the same host-agnostic
   * bookkeeping the extension uses, rather than a hand-rolled registry.
   */
  private unsubscribe: () => void = () => undefined;
  private toolEditApprovals: DesktopToolEditApprovalController | undefined;
  private hostInteractions!: DesktopHostInteractions;
  private fileActions!: DesktopProgressFileActions;
  private restartRepair: Promise<void> = Promise.resolve();
  // Restart repair also closes presentation-state running groups, so its retry
  // timer is deliberately presentation-owned. A window close cancels only the
  // timer; canonical status is retained and the next window reruns repair.
  private readonly restartRepairRetry = new RestartRepairRetryScheduler();
  private disposed = false;
  private presentationReady = false;

  readonly runtimeHost: AgentRuntimeHost;
  progressViewInboundHandlers!: DesktopProgressInboundHandlerRegistry;

  private readonly session: SessionHandle;
  /** Detaches this window's presentation from process-owned interactions. */
  private detachHostInteractions: () => void = () => undefined;
  private detachResultToast: () => void = () => undefined;

  constructor(
    private readonly postToRenderer: (message: unknown) => boolean | void,
    private readonly options: DesktopProgressBridgeOptions,
  ) {
    this.logger = options.logger ?? createChannelTrace('DesktopProgressBridge');
    const presentationHost: AgentRuntimeHost = {
      emit: (event, payload) => this.handleInteractionEvent(event, payload),
    };
    this.session = options.session;
    this.runtimeHost = this.session.interactions;
    const syncRenderedStreams = (): void =>
      this.syncStreamContent(this.updateStreamMetadata());

    this.backend = new ProgressBackend({
      session: this.session,
      stateOwnership: 'session',
      storage: platform().workspaceState,
      snapshots: options.progressSnapshotStore,
      stores: options.sessionStores,
      sendMessage: (message) => {
        return this.postToRenderer(message) !== false;
      },
      hasTarget: () => true,
      getStreamControls: (stream) =>
        getProgressStreamControls(stream, this.session),
      getUnsupportedCommands: () =>
        unsupportedCommands(this.progressViewInboundHandlers),
      approvals: {
        // The desktop renderer is always attached (no sidebar/editor re-target).
        canSend: () => true,
        logger: this.logger,
        overrides: {
          retry: {
            show: () => undefined,
            dismiss: () => undefined,
          },
        },
      },
      lifecycle: {
        stopStream: (stream) => {
          this.session.interactions.cancel({
            streamId: stream,
            kind: 'retry',
            cause: 'Retry request cleared.',
          });
          this.session.executions.stopAgentStream(stream, {
            detachActiveChildren: detachSubagentsOnStop(),
            runtimeHost: this.runtimeHost,
          });
        },
        cleanupDeletedStream: (stream) => {
          this.releaseApprovalsForStream(stream);
          this.workflowFileActions.clearStreamBackups(stream);
        },
        cleanupDeletedStreams: ({ allDeleted }) => {
          if (!allDeleted) return;
          cleanupUnscopedApprovals(this.session);
          this.session.interactions.cancel({ cause: 'All streams deleted.' });
          this.clearDesktopPresentationState();
          this.workflowFileActions.clearAllBackups();
        },
        rebuildRenderedStreams: ({ syncActiveStream = true }) => {
          const activeStream = this.updateStreamMetadata();
          if (syncActiveStream) this.syncStreamContent(activeStream);
        },
        refreshRenderedStreamsAfterDeletion: syncRenderedStreams,
        activateStream: (_stream) => syncRenderedStreams(),
        notifyDeletionRetained: (activeCount, failedCount) =>
          this.options.host.showInfoMessage(
            failedCount === 0
              ? formatActiveStreamRetention(activeCount)
              : formatStreamDeletionRetention(activeCount, failedCount),
          ),
      },
      onSetActiveStream: (payload) => {
        if (payload.streamId && payload.suppressViewSwitch !== true) {
          this.routeToProgress();
        }
      },
    });
    this.state = this.backend.state;
    this.streamLogs = this.state.streamLogs;
    this.restartRepair = this.initializeCanonicalState(presentationHost);
  }

  /** Wait until canonical state and restart repair are ready for use. */
  waitUntilReady(): Promise<void> {
    return this.restartRepair;
  }

  private async initializeCanonicalState(
    presentationHost: AgentRuntimeHost,
  ): Promise<void> {
    await this.backend.load();
    await this.repairOrphanedStreamsAfterRestart();
    if (this.disposed) return;

    this.toolEditApprovals = createDesktopToolEditApprovalController({
      runtimeHost: presentationHost,
      session: this.session,
      ui: this.options.host,
    });
    this.hostInteractions = createDesktopHostInteractions({
      runtimeHost: presentationHost,
      session: this.session,
      getApprovalHandlers: () => this.backend.approvalHandlers,
      getToolEditApprovals: () => this.toolEditApprovals!,
      showInfoMessage: (message) => this.options.host.showInfoMessage(message),
    });
    this.fileActions = new DesktopProgressFileActions(this.options.host, {
      startExecution: (request) => {
        const logger = this.logger;
        const runtimeHost = this.runtimeHost;
        let lifecycleStarted = false;
        void this.runExecution(request, {
          onLifecycleStart: () => {
            lifecycleStarted = true;
          },
        }).catch((error: unknown) => {
          logger.error('Desktop merge execution failed', {
            data: toLogData(error),
          });
          // Once the lifecycle starts, the process-session result listener
          // owns the one terminal error presentation.
          if (!lifecycleStarted) {
            runtimeHost.emit('requestShowError', {
              message: `Merge failed: ${toErrorMessage(error)}`,
            });
          }
        });
      },
      listWorkspaceCandidateFiles: () => this.listWorkspaceCandidateFiles(),
    });
    this.progressHost = this.createProgressViewHost();
    this.workflowFileActions = this.progressHost.workflowFileActionsController;
    this.agentProposalController = this.progressHost.agentProposalController;
    this.progressViewInboundHandlers = this.createProgressViewInboundHandlers();
    const backendSubscription = this.backend.setupEventListeners();
    const unsubscribeResult = this.session.onResult((event) => {
      if (event.outcome === 'completed') this.options.host.onRunCompleted();
    });
    this.unsubscribe = () => {
      backendSubscription.dispose();
      unsubscribeResult();
    };
    if (this.disposed) {
      this.unsubscribe();
      return;
    }
    // Canonical state and restart repair are complete before any window-owned
    // adapter can receive a replay. Subscribe first because attachment
    // synchronously redispatches pending approvals and their visibility facts.
    const detachHostInteractions = this.session.useHostInteractions(
      this.hostInteractions,
    );
    // Attachment synchronously replays pending requests. That replay can close
    // the window before useHostInteractions returns its disposer.
    if (this.disposed) {
      detachHostInteractions();
      return;
    }
    this.detachHostInteractions = detachHostInteractions;
    // A removal can begin after the pre-load drain but before these
    // subscriptions exist. Drain the one shared deletion owner again now;
    // subsequent events are observed live, and no await remains before the
    // first render can be enabled.
    await this.options.sessionStores.waitForPendingStreamDeletions();
    if (this.disposed) return;
    const detachResultToast = attachTerminalResultToast(
      this.session,
      this.runtimeHost,
      { replayWhenAttached: true },
    );
    // Missed-result replay is synchronous for the same reason as approval
    // replay above; never publish a disposer after this presentation closed.
    if (this.disposed) {
      detachResultToast();
      return;
    }
    this.detachResultToast = detachResultToast;
    // Close the load→subscribe gap. The process-owned snapshot listener may
    // have accepted metadata facts while restart repair was in flight; now
    // that live subscriptions are established, overlay that canonical state
    // once before any initial render.
    for (const streamId of this.streamLogs.keys()) {
      this.state.refreshStreamMetadataFromSnapshot(streamId);
    }
    // Child activity is live presentation state rather than durable history.
    // Seed it only after attaching the presentation and every live-event
    // subscription, so the first renderer output cannot precede either.
    for (const streamId of this.streamLogs.keys()) {
      const runConfig = this.state.snapshots.getRunConfig(streamId);
      if (runConfig) {
        this.state.getOrCreateStreamState(streamId, runConfig.agentCategory);
      }
      const { subagents, processes } =
        this.session.executions.getActiveChildren(streamId);
      if (subagents.length > 0) {
        this.backend.factApplier.handleRunFact(streamId, {
          type: 'child.activity',
          kind: 'subagents',
          parentStreamId: streamId,
          items: subagents,
        });
      }
      if (processes.length > 0) {
        this.backend.factApplier.handleRunFact(streamId, {
          type: 'child.activity',
          kind: 'processes',
          parentStreamId: streamId,
          items: processes,
        });
      }
    }
    this.presentationReady = true;
  }

  private createProgressViewHost(): ProgressViewHost {
    return new ProgressViewHost({
      run: {
        state: {
          getTaskState: (stream) => this.state.snapshots.getTaskState(stream),
          getExecutionId: (stream) => this.getStreamExecutionId(stream),
        },
        executeAgent: (request) => {
          const validated = validateExecutionRequest(request);
          if (!validated.valid) {
            this.logger.error('Invalid desktop workflow execution request', {
              data: validated.issue,
            });
            return Promise.resolve(
              this.options.host.showErrorMessage(validated.message),
            ).then(() => undefined);
          }
          return this.runExecution(validated.request);
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
          openDirectory: (directory) => this.options.host.openPath(directory),
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
        sendFollowUp: (stream, text) => this.sendFollowUp(stream, text),
      },
      agentProposal: {
        getPendingProposal: (proposalId) =>
          this.backend.approvalHandlers.agentProposal.get(proposalId),
        restoreTaskState: async (taskState) => this.restoreTaskState(taskState),
        settleProposal: (proposalId, result) => {
          const resolved = this.hostInteractions.submitProposalDecision(
            proposalId,
            result,
          );
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
          deleteStream: (stream) => this.backend.deleteStream(stream),
          deleteAllStreams: () => this.backend.deleteAllStreams(),
          stopStream: (stream) => this.backend.stopStream(stream),
        },
        resumeStream: (stream) => {
          void this.tryResumeStream(stream).catch((error: unknown) => {
            this.logger.warn(`Failed to resume desktop stream ${stream}`, {
              data: toLogData(error),
            });
          });
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
        },
        file: {
          openFile: (file, line) => this.options.host.openPath(file, line),
          openFileCompile: (file) => this.openFileCompile(file),
        },
        approval: {
          approvePendingDelegatedWork: (stream, initiatingProposalId) =>
            this.hostInteractions.approvePendingDelegatedWork(
              stream,
              initiatingProposalId,
            ),
          handleToolEditApprovalAction: (message) =>
            this.toolEditApprovals!.handleAction(message),
          handleBashApprovalAction: (message) =>
            void this.hostInteractions.submitBashDecision(
              message.requestId,
              message.action === 'approve'
                ? { action: 'approve' }
                : { action: 'reject', feedback: message.feedback },
            ),
          handlePlanApprovalAction: (message) => {
            this.hostInteractions.submitPlanDecision(
              message.approvalId,
              message.action === 'reject'
                ? { action: 'reject', feedback: message.feedback }
                : { action: message.action },
            );
          },
          handleUserQuestionAction: (message) => {
            this.hostInteractions.submitUserQuestionDecision(
              message.requestId,
              message.action === 'submit'
                ? { action: 'submit', answers: message.answers }
                : { action: message.action, feedback: message.feedback },
            );
            return undefined;
          },
        },
        externalInquiry: {
          session: this.session,
          dismiss: (threadId) =>
            this.hostInteractions.dismissExternalInquiry(threadId),
        },
      },
    });
  }

  private createProgressViewInboundHandlers(): DesktopProgressInboundHandlerRegistry {
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
    if (this.disposed) return;
    // Make this presentation sink inert before detaching resources owned by
    // the closing BrowserWindow.
    this.disposed = true;
    this.restartRepairRetry.dispose();
    // Detaching first advances the session's attachment generation. Any
    // cancellation produced while the old presenters are disposed is stale;
    // the process-owned request remains pending for the next window.
    this.detachHostInteractions();
    this.toolEditApprovals?.dispose();
    this.clearDesktopPresentationState();
    this.detachResultToast();
    this.unsubscribe();
    this.backend.dispose();
    this.workflowFileActions?.clearAllBackups();
  }

  private clearDesktopPresentationState(): void {
    // Settle only this detached presenter's promises and clear its request IDs.
    // SessionHostInteractions ignores those stale settlements and keeps each
    // process-owned request pending for the next attached presentation.
    if (!this.presentationReady) return;
    for (const handler of Object.values(this.backend.approvalHandlers)) {
      handler.clear();
    }
  }

  private send(message: ProgressViewOutboundMessage): void {
    this.postToRenderer(message);
  }

  private getStreamExecutionId(streamId: StreamTabId): ExecutionId | undefined {
    return (
      this.state.snapshots.getExecutionId(streamId) ??
      this.state.getStreamMetadata(streamId).executionId
    );
  }

  private refreshActiveExecutionIds(): {
    activeExecutionIds: Set<string>;
    allExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>;
  } {
    const activeExecutionIds = new Set(this.session.executions.getActiveIds());
    const allExecutionIds = this.state.snapshots.getExecutionIdMap();
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
    allExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>,
    activeExecutionIds: ReadonlySet<string>,
    waitingStreams: ReadonlySet<StreamTabId>,
  ): Set<StreamTabId> {
    const repairStreams = new Set([
      ...this.streamLogs.getUnfinishedStreamIds(),
      ...waitingStreams,
    ]);
    for (const [streamId, executionId] of allExecutionIds) {
      if (executionId && activeExecutionIds.has(executionId)) {
        repairStreams.delete(streamId);
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
      await this.state.streamLogs.flush();
    }
    return closedGroups;
  }

  private async repairOrphanedStreamsAfterRestart(): Promise<void> {
    let waitingStreams: Set<StreamTabId>;
    let repairActiveExecutionIds: Set<string>;
    let repairAllExecutionIds: ReadonlyMap<StreamTabId, ExecutionId>;
    try {
      const { activeExecutionIds, allExecutionIds } =
        this.refreshActiveExecutionIds();
      const executionIdMap = new Map(
        [...allExecutionIds].filter(
          ([, executionId]) => !activeExecutionIds.has(executionId),
        ),
      );
      ({
        waitingStreams,
        activeExecutionIds: repairActiveExecutionIds,
        allExecutionIds: repairAllExecutionIds,
      } = await this.detectRaceGuardedWaitingStreams(executionIdMap));
    } catch (error) {
      this.logger.warn('Failed to detect resumable desktop streams', {
        data: toLogData(error),
      });
      await this.repairUnmappedUnfinishedStreams();
      return;
    }

    const repairStreams = this.getRestartRepairStreamSet(
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
    this.syncAfterRestartRepair(repairResult);
    this.restartRepairRetry.schedule(repairResult.nextLeaseCheckAt, () => {
      void this.repairOrphanedStreamsAfterRestart().catch((error: unknown) => {
        this.logger.warn('Failed delayed restart repair', {
          data: toLogData(error),
        });
      });
    });
  }

  /**
   * If flow-record detection is unavailable, only streams without an execution
   * mapping are unambiguously crashed. Mapped streams may still be resumable,
   * so leave them untouched for a later retry instead of guessing.
   */
  private async repairUnmappedUnfinishedStreams(): Promise<void> {
    try {
      const { allExecutionIds } = this.refreshActiveExecutionIds();
      const repairStreams = this.streamLogs
        .getUnfinishedStreamIds()
        .filter((streamId) => !allExecutionIds.has(streamId));
      if (repairStreams.length === 0) return;

      const repairResult = await repairRestartedStreams({
        streamStatus: this.session.status,
        waitingStreams: new Set(),
        executionIds: allExecutionIds,
        repairStreams,
        closeRunningGroups: (streamIds, status, now) =>
          this.closeRunningTaskGroupsForStreams(streamIds, status, now),
        statusEmitOptions: { trace: this.logger },
        logger: this.logger,
      });
      this.syncAfterRestartRepair(repairResult);
    } catch (error) {
      this.logger.warn(
        'Failed to repair unmapped desktop streams after waiting detection failed',
        { data: toLogData(error) },
      );
    }
  }

  private syncAfterRestartRepair(result: RestartRepairResult): void {
    if (
      this.presentationReady &&
      (result.waitingStreams.length > 0 ||
        result.failedStreams.length > 0 ||
        result.closedWaitingGroups.length > 0 ||
        result.closedFailedGroups.length > 0)
    ) {
      this.syncFullView();
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
    if (this.disposed) return;
    if (isProgressBackendInteractionEvent(event)) {
      this.backend.handleInteractionEvent(
        event,
        payload as ProgressBackendInteractionPayloads[typeof event],
      );
      return;
    }

    if (!isRuntimePresentationEvent(event)) return;

    switch (event) {
      case 'requestEnsureProgressView': {
        const data =
          payload as AgentRuntimeEventPayloads['requestEnsureProgressView'];
        if (!data.fallbackNotification) this.routeToProgress();
        return;
      }
      case 'requestShowError':
      case 'requestShowInstruction': {
        const { message } = payload as
          | AgentRuntimeEventPayloads['requestShowError']
          | AgentRuntimeEventPayloads['requestShowInstruction'];
        void this.options.host.showErrorMessage(message);
        return;
      }
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
   * folded into `session.status` by `restartRepair`. Painting the rail before
   * repair settles would omit canonical restart status from the first paint.
   * Gating the whole sequence here makes the ordering uniform for every
   * `webviewReady` caller.
   */
  async completeWebviewReady(): Promise<void> {
    await this.restartRepair;
    this.syncFullView();
    await replayApprovalRequestHandlers(this.backend.approvalHandlers);
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
   * Resolves category via `buildStreamInfo` (canonical stream metadata), not
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

  deleteStream(streamId: StreamTabId): Promise<void> {
    return this.backend.deleteStream(streamId);
  }

  deleteAllStreams(): Promise<void> {
    return this.backend.deleteAllStreams();
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

  tryResumeStream(streamId: StreamTabId): Promise<boolean> {
    return this.restartRepair.then(() =>
      platform().agentResume.tryResumeStream(streamId),
    );
  }

  isResumeInFlight(streamId: StreamTabId): boolean {
    return platform().agentResume.isResumeInFlight?.(streamId) ?? false;
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

  private async sendFollowUp(
    streamId: StreamTabId,
    text: string,
    mediaFiles?: readonly string[],
  ): Promise<void> {
    await this.restartRepair;
    // Resolve the follow-up target against the process session: the run's
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
      const logger = this.logger;
      void wakeDesktopFollowUp(
        streamId,
        result,
        this.session,
        this.options.wakeQueuedFollowUpStream,
      ).catch((error: unknown) => {
        logger.warn(`Failed to wake follow-up stream ${streamId}`, {
          data: toLogData(error),
        });
      });
      return;
    }

    await this.options.host.showInfoMessage(
      'No active session. Start a new agent task to continue.',
    );
  }

  openFileCompile(filePath: string): Promise<void> {
    return this.fileActions.openFileCompile(filePath);
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

  runExecution(
    request: ValidatedExecutionRequest,
    options: DesktopRunExecutionOptions = {},
  ): Promise<void> {
    return launchDesktopAgent(
      request,
      {
        ready: this.restartRepair,
        session: this.session,
      },
      options,
    );
  }

  handleExecute(message: MainViewExecuteMessage): Promise<void> {
    const preparation = prepareMainViewExecutionRequest(message);
    if (!preparation.valid) {
      return Promise.resolve(
        this.options.host.showErrorMessage(preparation.message),
      ).then(() => undefined);
    }
    return this.runExecution(preparation.request);
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
   * stream from the pending guard. The process store owner settles underlying
   * approvals; this only clears prompts that never receive a
   * resolve event (e.g. durable external inquiries), keeping the guard from
   * blocking switches on a stream that no longer exists.
   */
  private releaseApprovalsForStream(streamId: StreamTabId): void {
    for (const handler of Object.values(this.backend.approvalHandlers)) {
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
      readDirectory: (directory) => platform().fs.readDirectory(directory),
    });
  }
}

export async function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): Promise<DesktopProgressBridge> {
  options.presentationSignal?.throwIfAborted();
  const progress = new DesktopProgressBridge(options.postToRenderer, {
    session: options.session,
    sessionStores: options.sessionStores,
    host: options.host,
    progressSnapshotStore: options.progressSnapshotStore,
  });
  const disposeAbortedPresentation = (): void => progress.dispose();
  options.presentationSignal?.addEventListener(
    'abort',
    disposeAbortedPresentation,
    { once: true },
  );
  try {
    await progress.waitUntilReady();
    options.presentationSignal?.throwIfAborted();
  } catch (error) {
    progress.dispose();
    throw error;
  } finally {
    options.presentationSignal?.removeEventListener(
      'abort',
      disposeAbortedPresentation,
    );
  }

  return progress;
}
