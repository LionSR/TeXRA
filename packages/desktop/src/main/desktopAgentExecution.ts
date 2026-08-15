import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentTrace } from '@agent/trace';

import { createChannelTrace } from '@agent/trace';
import type { SessionStores } from '@agent/storage';
import {
  detachSubagentsOnStop,
  dispatchPresentationEvent,
  polishTextWithAI,
  toPresentationDelivery,
  trackTerminalResultPresentation,
  type PresentationDelivery,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
  type SessionHostInteractions,
} from '@agent/runtime';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  validateExecutionRequest,
  type ExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import {
  presentFollowUpResult,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { getServerSideKeyService } from '@auth/serverKeys';
import { prepareMainViewExecutionLaunch } from '@controllers/mainView/backend/MainViewExecutionLaunchController';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { createAgentProposalTransport } from '@controllers/progressView/backend/agentProposalTransport';
import type { ProgressHostInteractions } from '@controllers/progressView/backend/progressHostInteractions';
import { replayApprovalRequestHandlers } from '@controllers/progressView/backend/progressBackendUiConfig';
import { buildStreamInfo } from '@controllers/session/streamInfoUtils';
import { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import { getProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';
import {
  ProgressFollowUpController,
  type ProgressFollowUpPlan,
} from '@controllers/progressView/ProgressFollowUpController';
import {
  ProgressFollowUpPolishController,
  type ProgressFollowUpPolishResult,
} from '@controllers/progressView/ProgressFollowUpPolishController';
import {
  ProgressWorkflowActionsController,
  type WorkflowDiffRequest,
  type WorkflowFileOperation,
  type WorkflowFileOperationRequest,
} from '@controllers/progressView/ProgressWorkflowActionsController';
import { ProgressViewHost } from '@controllers/progressView/ProgressViewHost';
import {
  createProgressViewSecondTierHandlers,
  type ProgressViewSecondTierActions,
} from '@controllers/progressView/ProgressViewCommandHandlers';
import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import { runCleanRunDir, runPackRunDir } from '@housekeeping/runDirOps';
import {
  API_PROVIDERS,
  hasUsableApiKey,
  lookupApiKey,
} from '@model/apiProviders';
import {
  computeModelOptionsData,
  invalidateModelOptionsCache,
} from '@model/computeModelOptions';
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import { platform } from '@platform/platform';
import {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
} from '@shared/ipc';
import {
  INSTRUCTION_ACTION,
  SETTINGS_TAB,
  type InstructionAction,
  type MainViewPersistedState,
  type ExecutionId,
  type RequestOpenFilePayload,
  type SettingsTab,
  type StreamTabId,
} from '@shared/schemas';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  formatActiveStreamRetention,
  formatStreamDeletionRetention,
} from '@shared/copy/executionHistory';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import type { FileOpResult } from '@shared/schemas/opResults';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { cleanupUnscopedApprovals } from '@tools/approval';
import { startRecording, stopRecordingAndTranscribe } from '@tools/media/audio';
import type { RunMetadata } from '@transcript/StreamSnapshotStore';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  postDesktopSettingsView,
  vsCodeOnlyGettingStartedMessage,
} from '../shared/desktopCommandSurface.js';
import { buildDesktopOnboardingSetStateMessage } from '../shared/desktopOnboardingMessages.js';
import { DESKTOP_SHELL_COMMANDS } from '../shared/desktopShellMessages.js';
import { DesktopToolEditApprovalHost } from './desktopToolEditApproval.js';
import { createDesktopHostInteractions } from './desktopHostInteractions.js';
import { listDesktopWorkspaceFiles } from './desktopFileSelection.js';
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

/**
 * Outcome of revealing a stream, mirroring the extension's progress navigation
 * so a settings-panel jump to a deleted run reports the same thing on both
 * hosts instead of silently doing nothing.
 */
export type DesktopStreamRevealResult = 'revealed' | 'missing';

/**
 * Desktop phrasing for the {@link InstructionAction} tokens the agent core
 * emits. The extension turns each token into a command button and the CLI into
 * a stderr hint; the desktop dialog has no buttons, so it reads as a hint too.
 * The `satisfies` clause keeps the table exhaustive at compile time while the
 * lookup type stays partial, so a token from a newer producer falls back to the
 * raw token rather than printing nothing.
 */
const INSTRUCTION_ACTION_HINT: Partial<Record<InstructionAction, string>> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: 'set your API key in Settings',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'see the configuration guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'see the model documentation',
} satisfies Record<InstructionAction, string>;

export interface DesktopAgentExecutionOptions {
  postToRenderer(message: unknown): boolean | void;
  host: DesktopAgentExecutionHost;
  session: SessionHandle;
  sessionStores: SessionStores;
  /** Aborts construction and detaches presentation when its window closes. */
  presentationSignal?: AbortSignal;
}

export interface DesktopProgressBridgeOptions {
  session: SessionHandle;
  sessionStores: SessionStores;
  logger?: AgentTrace;
  host: DesktopAgentExecutionHost;
}

export class DesktopProgressBridge {
  private readonly logger: AgentTrace;
  private readonly backend: ProgressBackend;
  private readonly state: ProgressBackend['state'];
  private readonly streamLogs: ProgressBackend['state']['streamLogs'];
  private progressHost!: ProgressViewHost;
  private agentProposalController!: ProgressViewHost['agentProposalController'];
  private workflowFileActions!: ProgressViewHost['workflowFileActionsController'];
  /**
   * Stream-toolbar diff/pack/clean. The controller is host-neutral: it resolves
   * each run's agent/model/input/output configuration from the shared snapshot
   * store and calls back into the two host-supplied operations below.
   */
  private workflowActions!: ProgressWorkflowActionsController;
  /** Plans compile-fix runs for a finished stream. */
  private followUpController!: ProgressFollowUpController;
  /** Rewrites follow-up text with the helper model ("Polish" in the follow-up box). */
  private readonly followUpPolishController: ProgressFollowUpPolishController;
  /** Switches a credit/limit-exhausted run onto the user's own API key. */
  private apiKeyRetryController!: ProgressApiKeyRetryController;
  /** Detaches the run-completion subscription that refreshes onboarding. */
  private detachCompletedResult: () => void = () => undefined;
  private toolEditApprovals: ToolEditApprovalController | undefined;
  private hostInteractions!: ProgressHostInteractions;
  private fileActions!: DesktopProgressFileActions;
  /**
   * One handler per `RuntimePresentationEvent`, dispatched via
   * `dispatchPresentationEvent` from `handlePresentationEvent` below. Built
   * once in the constructor (rather than per-call) since every handler body
   * only closes over `this`, which is stable for the bridge's lifetime.
   */
  private readonly presentationEventHandlers: PresentationEventHandlers<RuntimePresentationEventPayloads>;
  private readonly initialization: Promise<void>;
  private disposed = false;
  private presentationReady = false;

  progressViewInboundHandlers!: DesktopProgressInboundHandlerRegistry;

  private readonly session: SessionHandle;
  /** Detaches this window's presentation from process-owned interactions. */
  private detachHostInteractions: () => void = () => undefined;

  constructor(
    private readonly postToRenderer: (message: unknown) => boolean | void,
    private readonly options: DesktopProgressBridgeOptions,
  ) {
    this.logger = options.logger ?? createChannelTrace('DesktopProgressBridge');
    this.followUpPolishController = new ProgressFollowUpPolishController({
      polishText: (text, fileContext) =>
        polishTextWithAI(text, fileContext, options.session),
    });
    this.presentationEventHandlers = {
      // The desktop task shell keeps the conversation canvas permanently on
      // screen, so there is no separate progress surface to reveal.
      requestEnsureProgressView: () => undefined,
      requestShowError: ({ message }) => {
        void this.options.host.showErrorMessage(message);
      },
      requestShowInstruction: (instruction) => {
        // An instruction is actionable guidance, not a failure, so it uses
        // the info dialog. The desktop dialog carries no buttons, so the
        // action tokens the extension renders as buttons become trailing
        // hint text and `showSuppress` has no affordance to attach to.
        const hint = instruction.actions?.length
          ? ` (${instruction.actions
              .map((action) => INSTRUCTION_ACTION_HINT[action] ?? action)
              .join(', ')})`
          : '';
        void this.options.host.showInfoMessage(`${instruction.message}${hint}`);
        return true;
      },
      showAgentConfigBanner: ({ agentName }) => {
        return (
          this.postToRenderer({
            command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
            agentName,
            customDirSet: true,
          }) !== false
        );
      },
      requestOpenFile: (data: RequestOpenFilePayload) => {
        // Desktop has no editor integration to preview through, so the
        // resolved path goes to the preview-with-fallback host directly.
        this.options.host
          .openPath(data.location.absolutePath)
          .catch((error) => {
            this.logger.warn('Failed to open requested file on desktop', {
              data: toLogData(error),
            });
          });
      },
    };
    const presentationHost: Pick<SessionHostInteractions, 'emit'> = {
      emit: (event, payload) => this.handlePresentationEvent(event, payload),
    };
    this.session = options.session;
    this.backend = new ProgressBackend({
      session: this.session,
      stateOwnership: 'session',
      storage: platform().workspaceState,
      stores: options.sessionStores,
      sendMessage: (message) => this.postToRenderer(message) !== false,
      hasTarget: () => true,
      getStreamControls: (stream) =>
        getProgressStreamControls(stream, this.session),
      getUnsupportedCommands: () =>
        unsupportedCommands(this.progressViewInboundHandlers),
      reportTranscriptLoadError: (error, stream) =>
        this.reportTranscriptLoadError(error, stream),
      approvals: {
        // The desktop renderer is always attached (no sidebar/editor re-target).
        canSend: () => true,
        logger: this.logger,
        overrides: {
          // Route retry requests to the renderer's RetryRequestPanel: a parked
          // request blocks the run until the user answers it, so the card has
          // to be shown. Both are arrow functions, so `this.backend` is already
          // assigned by the time either runs.
          retry: {
            show: (permission) =>
              this.backend.webviewUpdater.showPermission({
                kind: PERMISSION_KIND.RETRY,
                data: permission,
              }),
            dismiss: (id) =>
              this.backend.webviewUpdater.resolvePermission(
                PERMISSION_KIND.RETRY,
                id,
              ),
          },
          proposal: createAgentProposalTransport({
            getWebviewUpdater: () => this.backend.webviewUpdater,
            isPending: (proposalId) =>
              this.backend.approvalHandlers.proposal.get(proposalId) !==
              undefined,
          }),
        },
      },
      lifecycle: {
        stopStream: (stream, options) => {
          if (options?.clearRetryRequest === true) {
            this.session.interactions.cancel({
              streamId: stream,
              kind: 'retry',
              cause: 'Retry request cleared.',
            });
          }
          this.session.executions.stopAgentStream(stream, {
            detachActiveChildren: detachSubagentsOnStop(),
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
        rebuildRenderedStreams: ({ syncActiveStream }) => {
          return this.syncRenderedStreams(syncActiveStream);
        },
        notifyDeletionRetained: (activeCount, failedCount) =>
          this.options.host.showInfoMessage(
            failedCount === 0
              ? formatActiveStreamRetention(activeCount)
              : formatStreamDeletionRetention(activeCount, failedCount),
          ),
      },
    });
    this.state = this.backend.state;
    this.streamLogs = this.state.streamLogs;
    this.detachCompletedResult = this.session.onResult((event) => {
      if (event.outcome === 'completed') this.options.host.onRunCompleted();
    });
    this.initialization = this.initializeCanonicalState(presentationHost);
  }

  /** Wait until canonical presentation state is ready for use. */
  waitUntilReady(): Promise<void> {
    return this.initialization;
  }

  private async initializeCanonicalState(
    presentationHost: Pick<SessionHostInteractions, 'emit'>,
  ): Promise<void> {
    await this.backend.load();
    if (this.disposed) return;

    this.toolEditApprovals = new ToolEditApprovalController({
      interactions: presentationHost,
      session: this.session,
      host: new DesktopToolEditApprovalHost({ ui: this.options.host }),
      showToolEditPermission: (payload) =>
        this.backend.approvalHandlers.toolEdit.show(payload),
      resolveToolEditPermission: (requestId) =>
        this.backend.approvalHandlers.toolEdit.dismiss(requestId),
      detachCause: SESSION_DISPOSED_CAUSE,
    });
    this.hostInteractions = createDesktopHostInteractions({
      interactions: presentationHost,
      session: this.session,
      getApprovalHandlers: () => this.backend.approvalHandlers,
      getToolEditApprovals: () => this.toolEditApprovals!,
      setApprovalBypassState: this.backend.setApprovalBypassState,
      showInfoMessage: (message) => this.options.host.showInfoMessage(message),
    });
    this.fileActions = new DesktopProgressFileActions(this.options.host, {
      startExecution: (request) => {
        const logger = this.logger;
        let executionId: string | undefined;
        const terminalResult = trackTerminalResultPresentation(
          this.session,
          (event) => event.executionId === executionId,
        );
        void this.runExecution(request, {
          suppressErrorNotification: true,
          onRun: (handle) => {
            executionId = handle.executionId;
          },
        })
          .catch((error: unknown) => {
            logger.error('Desktop merge execution failed', {
              data: toLogData(error),
            });
            if (!terminalResult.isHandled()) {
              this.session.interactions.emit('requestShowError', {
                message: `Merge failed: ${toErrorMessage(error)}`,
              });
            }
          })
          .finally(terminalResult.dispose);
      },
      listWorkspaceCandidateFiles: () => this.listWorkspaceCandidateFiles(),
    });
    this.progressHost = this.createProgressViewHost();
    this.workflowFileActions = this.progressHost.workflowFileActionsController;
    this.agentProposalController = this.progressHost.agentProposalController;
    this.workflowActions = this.createWorkflowActionsController();
    this.followUpController = this.createFollowUpController();
    this.apiKeyRetryController = this.createApiKeyRetryController();
    this.progressViewInboundHandlers = this.createProgressViewInboundHandlers();
    this.backend.setupEventListeners();
    if (this.disposed) return;
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
    // No metadata refresh loop: `getStreamMetadata` overlays the
    // always-resident summary mirror at read time, so canonical state
    // accepted during restart repair is already visible (#9947).
    //
    // Child activity is live presentation state rather than durable history.
    // Seed it only after attaching the presentation and every live-event
    // subscription, so the first renderer output cannot precede either.
    for (const streamId of this.streamLogs.keys()) {
      const category = this.state.getStreamMetadata(streamId).agentCategory;
      if (category) {
        this.state.getOrCreateStreamState(streamId, category);
      }
      const subagents = this.session.executions.getActiveChildren(streamId);
      if (subagents.length > 0) {
        this.session.events.emit({
          scope: 'run',
          streamId,
          event: {
            type: 'child.activity',
            parentStreamId: streamId,
            items: subagents,
          },
        });
      }
    }
    this.presentationReady = true;
  }

  /**
   * Mirrors the extension's `createWorkflowActionsController`
   * (`progressView/ProgressViewMessageHandler.ts`). The controller itself is
   * host-neutral; it reads each run's configuration from the same
   * `StreamSnapshotStore` both hosts share, so only the two terminal operations
   * differ per host. The extension routes them through `texra.runLatexdiff` /
   * `texra.pack` / `texra.clean` commands; the desktop calls the same
   * host-agnostic cores directly.
   */
  private createWorkflowActionsController(): ProgressWorkflowActionsController {
    return new ProgressWorkflowActionsController({
      state: {
        getRunMetadata: (stream) => this.getRunMetadata(stream),
        getOutputFiles: (stream) => this.state.snapshots.getOutputFiles(stream),
        getKnownWorkspaceOutputPaths: (stream) =>
          this.state.snapshots.getKnownFilePaths(stream, {
            workspaceOnly: true,
          }),
      },
      runDiff: (request) => this.runWorkflowDiff(request),
      runFileOperation: (operation, request) =>
        this.runWorkflowFileOperation(operation, request),
    });
  }

  /**
   * Mirrors the extension's `createApiKeyRetryController`. Every credential and
   * routing rule stays in the host-neutral controller; only the "ask the user
   * for a key" step is host-specific, and on the desktop that means opening the
   * Models tab rather than a modal prompt. The controller re-reads the secret
   * store after this returns, so a key entered there is picked up.
   */
  private createApiKeyRetryController(): ProgressApiKeyRetryController {
    return new ProgressApiKeyRetryController({
      providers: API_PROVIDERS,
      readKey: (provider) => lookupApiKey(platform().secrets, provider),
      hasUsableKey: (provider) => hasUsableApiKey(platform().secrets, provider),
      promptForApiKey: async () => {
        this.showSettings(SETTINGS_TAB.MODELS);
        await this.options.host.showInfoMessage(
          'Add a provider API key in Models, then use "Retry" on the request.',
        );
      },
      getUseIncludedModelAccess: () =>
        getServerSideKeyService().getUseIncludedModelAccess(),
      setUseIncludedModelAccess: async (enabled) => {
        await getServerSideKeyService().setUseIncludedModelAccess(enabled);
      },
      getPreferChatGptSubscription: isPreferCodexSubscription,
      setPreferChatGptSubscription: async (enabled) => {
        await setPreferCodexSubscription(enabled);
      },
      invalidateModelOptionsCache,
      isRetryPending: (stream, requestId) =>
        this.hostInteractions.isRetryPending(stream, requestId),
      triggerRetry: (stream, requestId) =>
        this.hostInteractions.submitRetryDecision(stream, requestId, {
          action: 'retry',
        }),
    });
  }

  /**
   * Mirrors the extension's `createFollowUpController`. The controller decides
   * what a compile-fix run should be; the desktop only supplies the catalog
   * lookups and the same snapshot-store reads.
   */
  private createFollowUpController(): ProgressFollowUpController {
    return new ProgressFollowUpController({
      loadModelOptions: () => computeModelOptionsData(),
      state: {
        getRunMetadata: (stream) => this.getRunMetadata(stream),
        getOutputFiles: (stream) => this.state.snapshots.getOutputFiles(stream),
        getCompileFailures: (stream) =>
          this.state.snapshots.getCompileFailures(stream),
      },
      workspace: {
        locatePath: (candidate) => WorkspaceFS.locatePath(candidate),
        exists: (relativePath) => WorkspaceFS.exists(relativePath),
      },
    });
  }

  private postRecordingStatus(
    status:
      { status: 'started' | 'stopped' } | { status: 'error'; error: string },
  ): void {
    this.postToRenderer({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING,
      ...status,
    });
  }

  /** Surface a dictation failure both to the renderer's mic button and the user. */
  private async reportRecordingError(message: string): Promise<void> {
    this.logger.error(`Recording failed: ${message}`);
    this.postRecordingStatus({ status: 'error', error: message });
    await this.options.host.showErrorMessage(message);
  }

  /** Desktop counterpart of the extension's `applyFollowUpPolishResult`. */
  private async applyFollowUpPolishResult(
    result: ProgressFollowUpPolishResult,
  ): Promise<void> {
    if (result.kind === 'skipped') return;
    this.postToRenderer(result.update);
    switch (result.kind) {
      case 'updated':
        return;
      case 'failed':
        await this.options.host.showErrorMessage(result.userMessage);
        return;
      case 'exception':
        this.logger.error(result.logMessage, {
          data: result.logData ? toLogData(result.logData) : undefined,
        });
        await this.options.host.showErrorMessage(result.userMessage);
    }
  }

  /**
   * Carry out a plan from `ProgressFollowUpController`, the desktop counterpart
   * of the extension's `applyFollowUpPlan`. As documented on the plan type, the
   * only `execute` producer is the compile fixer, so those runs opt into the
   * configured helper model.
   */
  private async applyFollowUpPlan(plan: ProgressFollowUpPlan): Promise<void> {
    switch (plan.kind) {
      case 'warning':
        await this.options.host.showWarningMessage(plan.message);
        return;
      case 'info':
        await this.options.host.showInfoMessage(plan.message);
        return;
      case 'execute': {
        await this.runValidatedExecutionRequest(plan.request, {
          preferHelperModel: true,
        });
      }
    }
  }

  /** Stream-toolbar diff: delegate to the shared round-aware latexdiff core. */
  private async runWorkflowDiff(request: WorkflowDiffRequest): Promise<void> {
    if (!request.agent || !request.model || !request.inputFile) {
      await this.options.host.showErrorMessage(
        'Missing required configuration parameters for the diff.',
      );
      return;
    }

    await this.fileActions.diffStreamToolbarAction({
      outputsByRound: request.outputsByRound ?? {},
      ...(request.runId && { executionId: request.runId }),
      workspaceScan: {
        agent: request.agent,
        model: request.model,
        inputFile: request.inputFile,
        outputFiles: request.outputFiles,
      },
    });
  }

  /**
   * Stream-toolbar pack/clean for artifacts in the current execution directory.
   */
  private async runWorkflowFileOperation(
    operation: WorkflowFileOperation,
    request: WorkflowFileOperationRequest,
  ): Promise<void> {
    const { agent, model, inputFile, executionId } = request;
    if (!agent || !model || !inputFile) {
      await this.options.host.showErrorMessage(
        `Select an input file before ${operation === 'pack' ? 'packing' : 'cleaning'}.`,
      );
      return;
    }

    if (!executionId) {
      await this.options.host.showErrorMessage(
        `Missing execution identity for ${operation}.`,
      );
      return;
    }

    let result: FileOpResult;
    try {
      result =
        operation === 'pack'
          ? await runPackRunDir(
              executionId as ExecutionId,
              agent,
              model,
              inputFile,
            )
          : await runCleanRunDir(executionId as ExecutionId);
    } catch (error) {
      this.logger.error(`Desktop ${operation} operation failed`, {
        data: toLogData(error),
      });
      await this.options.host.showErrorMessage(
        `Error during ${operation}: ${toErrorMessage(error)}`,
      );
      return;
    }

    await this.reportFileOperationResult(operation, result, inputFile);
  }

  private async reportFileOperationResult(
    operation: WorkflowFileOperation,
    result: FileOpResult,
    inputFile: string,
  ): Promise<void> {
    switch (result.status) {
      case 'success': {
        const folder = result.outputFolder;
        const packedMessage = folder
          ? `Files packed into ${folder}`
          : 'Files packed.';
        await this.options.host.showInfoMessage(
          operation === 'pack' ? packedMessage : 'Output files cleaned.',
        );
        return;
      }
      case 'noFiles':
        await this.options.host.showInfoMessage(
          `No files found to ${operation} for ${inputFile}`,
        );
        return;
      case 'missingParams':
        await this.options.host.showErrorMessage(
          `Select an input file before ${operation === 'pack' ? 'packing' : 'cleaning'}.`,
        );
        return;
      case 'error':
        await this.options.host.showErrorMessage(
          `Error during ${operation}: ${result.error}`,
        );
        return;
    }
  }

  private createProgressViewHost(): ProgressViewHost {
    return new ProgressViewHost({
      run: {
        state: {
          getRunMetadata: (stream) => this.getRunMetadata(stream),
        },
        runExecutionRequest: async (request) => {
          await this.runValidatedExecutionRequest(request);
        },
      },
      workflowFileActions: {
        state: {
          getActiveStream: () => this.backend.presentation.activeStream,
          getRunMetadata: (stream) => this.getRunMetadata(stream),
          getOutputFiles: (stream) =>
            this.state.snapshots.getOutputFiles(stream),
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
          this.backend.approvalHandlers.proposal.get(proposalId),
        restoreRunConfig: async (config) => this.restoreRunConfig(config),
        openFile: (file) => this.options.host.openPath(file),
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
          setActiveStream: (stream, requestId) =>
            this.setActiveStream(stream, requestId),
          deleteStream: (stream) => this.backend.deleteStream(stream),
          deleteAllStreams: () => this.backend.deleteAllStreams(),
          stopStream: (stream) => this.backend.stopStream(stream),
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
          session: this.session,
          showInfo: (message) => this.options.host.showInfoMessage(message),
        },
        file: {
          openFile: (file, line) => this.options.host.openPath(file, line),
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
    const secondTierActions: ProgressViewSecondTierActions = {
      getRunMetadata: (stream) => this.getRunMetadata(stream),
      workflowActions: this.workflowActions,
      apiKeyRetry: this.apiKeyRetryController,
      followUp: this.followUpController,
      followUpPolish: this.followUpPolishController,
      host: {
        showInfo: async (message) => {
          await this.options.host.showInfoMessage(message);
        },
      },
      session: this.session,
      getRunConfig: (stream) =>
        this.state.snapshots.getRunMetadata(stream).config,
      restoreRunConfig: async (config) => {
        const restored = this.restoreRunConfig(config);
        if (!restored) {
          await this.options.host.showErrorMessage('Failed to restore state');
        }
      },
      applyFollowUpPlan: (plan) => this.applyFollowUpPlan(plan),
      applyPolishResult: (result) => this.applyFollowUpPolishResult(result),
      onPolishError: async (stream, error) => {
        const message = toErrorMessage(error);
        this.postToRenderer({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
          stream,
          kind: 'polishError',
          text: null,
          error: message,
        });
        this.logger.error(`Error polishing follow-up: ${message}`, {
          data: toLogData(error),
        });
        await this.options.host.showErrorMessage(
          `Error polishing follow-up: ${message}`,
        );
      },
      postToRenderer: (message) => this.postToRenderer(message),
      restoreProposalConfig: async (proposal) => {
        await this.agentProposalController.restoreProposalConfig(proposal);
      },
      retry: {
        submit: (stream, requestId, feedback) =>
          this.hostInteractions.submitRetryDecision(stream, requestId, {
            action: 'retry',
            feedback,
          }),
        cancel: (stream, requestId) =>
          this.hostInteractions.submitRetryDecision(stream, requestId, {
            action: 'cancel',
          }),
      },
    };

    return {
      // First-tier shared progress command groups
      ...this.progressHost.commandHandlers,

      // Second-tier shared progress command groups
      ...createProgressViewSecondTierHandlers(secondTierActions),

      // Host-specific handlers below
      // Getting-started actions from the progress empty-state. openWalkthrough
      // has a desktop equivalent; the remaining four actions are VS Code-only.
      [PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION]: async (data) => {
        if (data.action === 'openWalkthrough') {
          this.postToRenderer(buildDesktopOnboardingSetStateMessage(true));
          return;
        }
        await this.options.host.showInfoMessage(
          vsCodeOnlyGettingStartedMessage(data.action),
        );
      },
      // Recording: the desktop calls standalone functions and posts status
      // manually; the extension wraps it in a webview-bound RecordingManager.
      startRecording: async () => {
        try {
          const result = await startRecording();
          if (result.success) {
            this.postRecordingStatus({ status: 'started' });
          } else if (result.error) {
            await this.reportRecordingError(result.error);
          }
        } catch (error) {
          await this.reportRecordingError(toErrorMessage(error));
        }
      },
      stopRecording: async () => {
        try {
          const transcription = stopRecordingAndTranscribe();
          this.postRecordingStatus({ status: 'stopped' });
          const result = await transcription;
          if (result.success) {
            this.postToRenderer({
              command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
              kind: 'transcribed',
              text: result.text,
            });
          } else if (result.error) {
            await this.reportRecordingError(result.error);
          }
        } catch (error) {
          await this.reportRecordingError(toErrorMessage(error));
          this.postRecordingStatus({ status: 'stopped' });
        }
      },
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
    this.detachCompletedResult();
    // Detaching first advances the session's attachment generation. Any
    // cancellation produced while the old presenters are disposed is stale;
    // the process-owned request remains pending for the next window.
    this.detachHostInteractions();
    this.toolEditApprovals?.dispose();
    this.clearDesktopPresentationState();
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

  private getRunMetadata(streamId: StreamTabId): RunMetadata {
    const metadata = this.state.snapshots.getRunMetadata(streamId);
    return {
      ...metadata,
      executionId:
        metadata.executionId ??
        this.state.getStreamMetadata(streamId).executionId,
    };
  }

  /**
   * Open the settings overlay, optionally on a specific tab, through the same
   * owner the rail and menu commands use, so a stream-initiated navigation
   * lands identically.
   */
  private showSettings(tabIndex?: SettingsTab): void {
    postDesktopSettingsView(
      (message) => this.postToRenderer(message),
      tabIndex,
    );
  }

  private handlePresentationEvent<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): PresentationDelivery {
    if (this.disposed) return false;

    return toPresentationDelivery(
      dispatchPresentationEvent(this.presentationEventHandlers, event, payload),
    );
  }

  private syncFullView(): void {
    void this.syncRenderedStreams(true);
  }

  private async syncRenderedStreams(syncActiveStream: boolean): Promise<void> {
    await this.backend.syncRenderedStreams({ syncActiveStream });
  }

  /** Send canonical state and replay pending prompts after attachment. */
  async completeWebviewReady(): Promise<void> {
    this.syncFullView();
    await replayApprovalRequestHandlers(this.backend.approvalHandlers);
  }

  private async setActiveStream(
    streamId: StreamTabId | '',
    requestId?: string,
  ): Promise<void> {
    await this.backend.activateStream(streamId, requestId);
  }

  /**
   * Display label for a stream, the desktop counterpart of the extension's
   * `getProgressStreamLabel`.
   */
  getStreamLabel(streamId: StreamTabId): string | undefined {
    return buildStreamInfo(
      this.state,
      streamId,
      this.backend.presentation.activeStream,
    ).label;
  }

  /**
   * Select the given stream as this window's active stream.
   * Mirrors the extension's `revealProgressStream`, so jumping from a settings
   * entry to its owning run works the same way on both hosts.
   */
  async revealStream(
    streamId: StreamTabId,
  ): Promise<DesktopStreamRevealResult> {
    if (!this.streamLogs.has(streamId)) {
      return 'missing';
    }
    await this.setActiveStream(streamId);
    return 'revealed';
  }

  private reportTranscriptLoadError(
    error: unknown,
    streamId?: StreamTabId | '',
  ): void {
    this.logger.error(
      `Failed to load desktop transcript${streamId ? ` ${streamId}` : ''}`,
      {
        data: toLogData(error),
      },
    );
    void this.options.host.showErrorMessage(
      `Transcript load failed: ${toErrorMessage(error)}`,
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

    await this.fileActions.diffAcceptedFilePair(baseFile, editedFile, context);
  }

  private getActiveLatexdiffRunContext(
    editedFile: string,
  ): DesktopLatexdiffRunContext | undefined {
    const stream = this.backend.presentation.activeStream;
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
    const { config, executionId } = this.getRunMetadata(stream);
    const workspaceScan = config
      ? this.getLatexdiffWorkspaceScan(config, editedFile)
      : undefined;
    if (Object.keys(outputsByRound).length === 0 && !workspaceScan) {
      return undefined;
    }

    return {
      outputsByRound,
      ...(executionId && { executionId }),
      ...(workspaceScan && { workspaceScan }),
    };
  }

  private getLatexdiffWorkspaceScan(
    config: AgentConfig,
    editedFile: string,
  ): DesktopLatexdiffWorkspaceScan {
    const { agent, model, inputFiles, outputFiles } = config;
    const inputFile = inputFiles.at(0) ?? editedFile;
    // Thread the run's output files so multi-document runs resolved via the
    // run-dir / workspace scan diff every output, not just the primary input.
    return {
      agent,
      model,
      inputFile,
      ...(outputFiles?.length ? { outputFiles } : {}),
    };
  }

  private sendFollowUp(
    streamId: StreamTabId,
    text: string,
    mediaFiles?: readonly string[],
  ): Promise<void> {
    // Resolve the follow-up target against the process session: the run's
    // handle is tracked in `this.session`, but this IPC path runs outside the
    // run ALS, so the module default (currentSession ⇒ defaultSession) would
    // look in the wrong registry and report `no_session` for a live run.
    // Admission and the recovery claim happen synchronously inside
    // submitFollowUp. Presentation remains detached because recovery may run a
    // complete agent turn; closing a desktop window must not await that turn.
    void submitFollowUp(
      streamId,
      { text, mediaFiles },
      { session: this.session },
    )
      .then(async (result) => {
        if (result.status === 'sent' || result.status === 'queued') {
          this.session.events.emit({
            scope: 'session',
            event: {
              type: 'updateQueuedFollowUps',
              payload: { streamId },
            },
          });
          const presentation = presentFollowUpResult(result);
          if (presentation.severity !== 'none') {
            await this.session.interactions.showInfoMessage(
              presentation.message,
              {
                replayWhenAttached: true,
              },
            );
          }
          return;
        }

        await this.options.host.showInfoMessage(
          'No active session. Start a new agent task to continue.',
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(`Failed to submit follow-up for stream ${streamId}`, {
          data: toLogData(error),
        });
      });
    return Promise.resolve();
  }

  /**
   * Restore a run's setup into the main view: builds the host-neutral
   * persisted-state snapshot and shows it in the launcher. Shared by the
   * in-session "restore this proposal" flow (`agentProposal.restoreRunConfig`
   * above) and desktop history's "Setup" action (settings IPC), which mirrors
   * the extension's `texra.restoreState` command.
   */
  restoreRunConfig(config: AgentConfig): boolean {
    let state: MainViewPersistedState;
    try {
      state = buildMainViewState(config);
    } catch (error) {
      this.logger.error('Failed to build main-view state for restore', {
        data: toLogData(error),
      });
      return false;
    }
    this.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER,
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
        session: this.session,
      },
      options,
    );
  }

  private async runValidatedExecutionRequest(
    request: ExecutionRequest,
    options?: DesktopRunExecutionOptions,
  ): Promise<void> {
    const validated = validateExecutionRequest(request);
    if (!validated.valid) {
      this.logger.error('Invalid desktop execution request', {
        data: validated.issue,
      });
      await this.options.host.showErrorMessage(validated.message);
      return;
    }
    await this.runExecution(validated.request, options);
  }

  async handleExecute(message: MainViewExecuteMessage): Promise<void> {
    const launch = await prepareMainViewExecutionLaunch(
      message,
      this.options.host,
    );
    if (launch.status === 'cancelled') return;
    if (launch.status === 'error') {
      await this.options.host.showErrorMessage(launch.message);
      return;
    }
    if (launch.infoMessage) {
      await this.options.host.showInfoMessage(launch.infoMessage);
    }
    const { preparation } = launch;
    if (!preparation.valid) {
      await this.options.host.showErrorMessage(preparation.message);
      return;
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
      ...(await listDesktopWorkspaceFiles('input', workspacePath)),
      ...(await listDesktopWorkspaceFiles('context', workspacePath)),
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
}

export async function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): Promise<DesktopProgressBridge> {
  options.presentationSignal?.throwIfAborted();
  const progress = new DesktopProgressBridge(options.postToRenderer, {
    session: options.session,
    sessionStores: options.sessionStores,
    host: options.host,
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
