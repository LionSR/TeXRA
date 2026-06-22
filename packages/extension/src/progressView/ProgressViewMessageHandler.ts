import * as vscode from 'vscode';

import { createProgressViewCommandHandlers } from '@controllers/progressView/ProgressViewCommandHandlers';
import { ProgressStreamLifecycleController } from '@controllers/progressView/ProgressStreamLifecycleController';
import {
  ProgressFollowUpController,
  type ProgressFollowUpPlan,
} from '@controllers/progressView/ProgressFollowUpController';
import {
  ProgressFollowUpPolishController,
  type ProgressFollowUpPolishResult,
} from '@controllers/progressView/ProgressFollowUpPolishController';
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';
import { ProgressWorkflowActionsController } from '@controllers/progressView/ProgressWorkflowActionsController';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { getAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { runCoordinatorBridge } from '@agent/runtime/runCoordinators';
import {
  validateExecutionRequest,
  type ExecutionRequest,
} from '@agent/core/execution/executionRequests';
import { getServerSideKeyService } from '@auth/serverKeys';
import { apiKeyCommands } from '@commands/api/apiKeyCommands';
import { toErrorMessage } from '@common/errors';
import { BaseViewMessageHandler } from '@common/webview';
import { bus } from '@eventBus/ProgressEventBus';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { handleProgressViewToolEditApprovalAction } from '@frontend/approval/nativeToolEditApproval';
import { RecordingManager } from '@frontend/media/RecordingManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { isApiProvider } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';
import { isGoalInFlight } from '@shared/schemas/goal';
import {
  dispatchProgressViewInbound,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { handleExternalInquiryAction } from '@tools/inquiry';
import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleProgressViewBashApprovalAction } from '@tools/approval';
import { GoalStore } from '@tools/goal';
import { persistOpenTurnDraft } from '@tools/inquiry/externalInquiryStorage';
import {
  createExternalLocation,
  flexibleFS,
  pathToLocation,
  WorkspaceFS,
} from '@utils/files';

import { ProgressStreamLifecycleHost } from './managers/ProgressStreamLifecycleHost';
import type { ProgressViewProvider } from './ProgressViewProvider';

// Type helper for extracting specific message types
type MessageFor<C extends ProgressViewInboundMessage['command']> = Extract<
  ProgressViewInboundMessage,
  { command: C }
>;

/**
 * Schema-driven message handler for ProgressView.
 *
 * Uses discriminated union validation at dispatch point (single safeParse)
 * with typed handler registry for type-safe message handling.
 */
export class ProgressViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly recordingManager: RecordingManager;
  private readonly streamLifecycleController: ProgressStreamLifecycleController;
  private readonly workflowActionsController: ProgressWorkflowActionsController;
  private readonly workflowFileActionsController: ProgressWorkflowFileActionsController;
  private readonly agentProposalController: ProgressAgentProposalController;
  private readonly apiKeyRetryController: ProgressApiKeyRetryController;
  private readonly followUpController: ProgressFollowUpController;
  private readonly followUpPolishController: ProgressFollowUpPolishController;

  /**
   * Type-safe handler registry - handlers receive typed data.
   */
  private readonly handlerRegistry: ProgressViewInboundHandlerRegistry;

  constructor(
    private readonly provider: ProgressViewProvider,
    context: vscode.ExtensionContext,
  ) {
    super('ProgressView', { trackActiveView: true });

    this.recordingManager = new RecordingManager(context, {
      buildRecordingMessage: ({ status, error }) => ({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING,
        status,
        ...(error && { error }),
      }),
      buildTranscriptionMessage: (text) => ({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
        kind: 'transcribed',
        text,
      }),
      progressTitle: 'Transcribing follow-up message',
    });

    this.workflowFileActionsController =
      this.createWorkflowFileActionsController();
    this.streamLifecycleController = this.createStreamLifecycleController();
    this.workflowActionsController = this.createWorkflowActionsController();
    this.agentProposalController = this.createAgentProposalController();
    this.apiKeyRetryController = this.createApiKeyRetryController();
    this.followUpController = this.createFollowUpController();
    this.followUpPolishController = new ProgressFollowUpPolishController();
    this.handlerRegistry = this.createHandlerRegistry();

    const unsubscribeRemoveStream = bus.on('removeStream', ({ streamId }) => {
      void this.streamLifecycleController.deleteStream(streamId);
      void GoalStore.forget(streamId);
    });
    context.subscriptions.push({ dispose: unsubscribeRemoveStream });

    const unsubscribeGoal = bus.on('goalStateChanged', ({ streamId }) => {
      const goal = GoalStore.getForStream(streamId);
      this.provider.webviewUpdater.updateGoalActive(
        streamId,
        isGoalInFlight(goal),
        { status: goal?.status, objective: goal?.objective },
      );
    });
    context.subscriptions.push({ dispose: unsubscribeGoal });
  }

  /**
   * Create the typed handler registry.
   * Each handler receives typed data - no casts or validation needed.
   */
  private createHandlerRegistry(): ProgressViewInboundHandlerRegistry {
    return {
      // Common handlers - passthrough to webview
      [PROGRESS_VIEW_COMMANDS.WEBVIEW_READY]: () =>
        this.handleWebviewReadySignal(),
      [PROGRESS_VIEW_COMMANDS.THEME_SET]: (data) => this.postToActiveView(data),
      [PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET]: (data) =>
        this.postToActiveView(data),
      [COMMON_COMMANDS.SWITCH_VIEW]: async (data) => {
        if (data.view === 'dashboard') {
          await vscode.commands.executeCommand('texra.showDashboard');
          return;
        }
        if (data.view === 'main') {
          await vscode.commands.executeCommand('texra.showMainView');
          return;
        }
        if (data.openInEditor) {
          await this.provider.popOutToEditor();
          return;
        }
        await vscode.commands.executeCommand('texra.showProgressView');
      },
      [PROGRESS_VIEW_COMMANDS.POP_OUT]: () => this.provider.popOutToEditor(),
      [PROGRESS_VIEW_COMMANDS.POP_BACK]: () => this.provider.popBackToSidebar(),

      // Shared progress command groups
      ...createProgressViewCommandHandlers({
        lifecycle: {
          setActiveStream: (stream) => this.provider.setActiveStream(stream),
          setAgentFilter: (filter) => {
            this.provider.state.agentCategoryFilter = filter;
            this.provider.syncFullView();
          },
          deleteStream: (stream) =>
            this.streamLifecycleController.deleteStream(stream),
          deleteAllStreams: () => this.handleDeleteAll(),
          stopStream: (stream) =>
            this.streamLifecycleController.stopStream(stream),
        },
        run: {
          resumeStream: (stream) =>
            this.workflowActionsController.resume(stream),
          runNewStream: (stream) =>
            this.workflowActionsController.runNew(stream),
        },
        followUp: {
          sendFollowUp: async ({ stream, text, mediaFiles }) => {
            await vscode.commands.executeCommand('texra.sendFollowUp', {
              stream,
              text,
              ...(mediaFiles && mediaFiles.length > 0 ? { mediaFiles } : {}),
            });
          },
          reportImageSaveError: (_image, error) => {
            // Best-effort: a failed image save must not block the text, but log
            // it so a missing attachment is diagnosable.
            this.logger.warn(
              this.channel,
              `Failed to save pasted follow-up image: ${toErrorMessage(error)}`,
            );
          },
        },
        bypass: {
          runtimeHost: extensionAgentRuntimeHost,
          showInfo: (message) => vscode.window.showInformationMessage(message),
        },
        file: {
          openFile: async (file, line) =>
            vscode.commands.executeCommand('texra.openFile', file, line),
          openFileCompile: async (file) =>
            vscode.commands.executeCommand('texra.openFileCompile', file),
          openTaskStorage: (stream) =>
            this.workflowFileActionsController.openTaskStorage(stream),
          compareOriginal: (file, base) =>
            this.workflowFileActionsController.compareOriginal(file, base),
          comparePrevious: (file, base, previous) =>
            this.workflowFileActionsController.comparePrevious(
              file,
              base,
              previous,
            ),
          acceptFile: (file, base) =>
            this.workflowFileActionsController.acceptFile(file, base),
          mergeFile: (file, base) =>
            this.workflowFileActionsController.mergeFile(file, base),
          latexdiffFile: (file, base) =>
            this.workflowFileActionsController.latexdiffFile(file, base),
          openLabel: (label) =>
            this.workflowFileActionsController.openLabel(label),
        },
        approval: {
          handleToolEditApprovalAction: async (message) => {
            await handleProgressViewToolEditApprovalAction(message);
            return true;
          },
          handleBashApprovalAction: (message) =>
            handleProgressViewBashApprovalAction(message),
          handlePlanApprovalAction: (message) =>
            this.handlePlanApprovalAction(message),
          handleUserQuestionAction: (message) =>
            handleUserQuestionAction(message),
          handleAgentProposalAction: (message) =>
            this.agentProposalController.handleAction(message),
        },
      }),
      [PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE]: async (data) =>
        vscode.commands.executeCommand('texra.compactResponse', data.stream),

      // Actions
      [PROGRESS_VIEW_COMMANDS.DIFF_STREAM]: (data) =>
        this.workflowActionsController.diffStream(data.stream),
      [PROGRESS_VIEW_COMMANDS.PACK_STREAM]: (data) =>
        this.workflowActionsController.runFileOperation(data.stream, 'pack'),
      [PROGRESS_VIEW_COMMANDS.CLEAN_STREAM]: (data) =>
        this.workflowActionsController.runFileOperation(data.stream, 'clean'),
      [PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST]: (data) =>
        this.handleRetryStreamRequest(data),
      [PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST]: (data) => {
        runCoordinatorBridge.cancelRetry(data.stream);
      },
      [PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY]: (data) =>
        this.handleUseOwnApiKey(data),
      [PROGRESS_VIEW_COMMANDS.RESTORE_STATE]: async (data) => {
        const taskState = this.provider.state.snapshots.getTaskState(
          data.stream,
        );
        if (taskState) {
          await vscode.commands.executeCommand('texra.restoreState', taskState);
        }
      },
      [PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP]: (data) =>
        this.handlePolishFollowUp(data),
      [PROGRESS_VIEW_COMMANDS.START_RECORDING]: async () => {
        const view = this.getActiveView();
        if (view) await this.recordingManager.start(view);
      },
      [PROGRESS_VIEW_COMMANDS.STOP_RECORDING]: async () => {
        const view = this.getActiveView();
        if (view) await this.recordingManager.stop(view);
      },
      [PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: async (data) => {
        await vscode.window.showInformationMessage(data.text);
      },
      [PROGRESS_VIEW_COMMANDS.RESTORE_PROPOSAL_CONFIG]: async (data) => {
        const restored =
          await this.agentProposalController.restoreProposalConfig(
            data.proposal,
          );
        if (restored) {
          this.logger.info(
            this.channel,
            'Restored proposal config to main view',
            {
              data: {
                agent: data.proposal.agent,
                agentCategory: data.proposal.agentCategory,
              },
            },
          );
        }
      },
      [PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION]: async (data) => {
        if (data.action === 'draft') {
          await persistOpenTurnDraft({
            threadId: data.threadId,
            draft: data.draft ?? null,
          });
          return;
        }
        if (data.action === 'submit') {
          if (data.answer == null || data.answer.length === 0) {
            this.logger.warn(
              this.channel,
              'Ignoring external inquiry submit without an answer',
              { data: { threadId: data.threadId } },
            );
            return;
          }
          await handleExternalInquiryAction({
            action: 'submit',
            threadId: data.threadId,
            answer: data.answer,
            sessionLinks: data.sessionLinks,
          });
          return;
        }
        await handleExternalInquiryAction({
          action: 'drop',
          threadId: data.threadId,
          feedback: data.feedback,
        });
      },

      // Profile & Memory - direct command execution
      [PROGRESS_VIEW_COMMANDS.OPEN_PROFILE]: async () => {
        await vscode.commands.executeCommand('texra.auth.viewProfile');
      },
      [PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW]: async () => {
        await vscode.commands.executeCommand('texra.showMemory');
      },

      // Followup task
      [PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS]: (data) =>
        this.handleGetFollowupOptions(data.stream),
      [PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP]: (data) =>
        this.processToolUseFollowup(data, false),
      [PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP]: (data) =>
        this.processToolUseFollowup(data, true),
      [PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER]: (data) =>
        this.handleRunCompileFixer(data.stream),

      [PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION]: async (data) => {
        switch (data.action) {
          case 'runSetup':
            await safeExecuteCommand(
              'texra.runSetupAssistant',
              [],
              this.viewName,
            );
            await this.provider.refreshOnboardingFunnel();
            break;
          case 'createSampleProject':
            await safeExecuteCommand(
              'texra.createSampleProject',
              [],
              this.viewName,
            );
            break;
          case 'cloneOverleaf':
            await safeExecuteCommand(
              'texra.cloneOverleafProject',
              [],
              this.viewName,
            );
            break;
          case 'downloadArxiv':
            await safeExecuteCommand(
              'texra.downloadArXivSource',
              [],
              this.viewName,
            );
            break;
          case 'openWalkthrough':
            await safeExecuteCommand(
              'texra.openGettingStarted',
              [],
              this.viewName,
            );
            break;
          default: {
            const exhaustive: never = data.action;
            throw new Error(`Unhandled getting-started action: ${exhaustive}`);
          }
        }
      },
    };
  }

  /**
   * Main message handler - uses schema-driven dispatch.
   * Single safeParse at entry, routes to typed handlers.
   */
  public override async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.dispatchInbound(
      message,
      webviewView,
      dispatchProgressViewInbound,
      this.handlerRegistry,
    );
  }

  // ============================================================
  // Common handlers
  // ============================================================

  private handleWebviewReadySignal(): void {
    this.logger.debug(this.channel, 'Webview ready signal received');
    const view = this.getActiveView();
    if (view) {
      this.provider.markWebviewReady(view);
    }
  }

  private createStreamLifecycleController(): ProgressStreamLifecycleController {
    return new ProgressStreamLifecycleController({
      state: {
        getActiveStream: () => this.provider.state.activeStream,
        setActiveStream: (stream) => {
          this.provider.state.activeStream = stream;
        },
        hasStream: (stream) => this.provider.state.streamLogs.has(stream),
        hasTaskState: (stream) =>
          Boolean(this.provider.state.snapshots.getTaskState(stream)),
        getStreamIds: () => this.provider.state.streamLogs.keys(),
        pickValidActiveStream: (streams) =>
          this.provider.state.pickValidActiveStream(streams),
        clearStream: (stream) => this.provider.state.clearStream(stream),
        clearAll: () => this.provider.state.clearAll(),
      },
      host: new ProgressStreamLifecycleHost(
        this.provider,
        this.workflowFileActionsController,
      ),
    });
  }

  private createWorkflowActionsController(): ProgressWorkflowActionsController {
    return new ProgressWorkflowActionsController({
      state: {
        getTaskState: (stream) =>
          this.provider.state.snapshots.getTaskState(stream),
        getExecutionId: (stream) =>
          this.provider.state.snapshots.getExecutionId(stream),
        getOutputFiles: (stream) =>
          this.provider.state.snapshots.getOutputFiles(stream),
        getKnownWorkspaceOutputPaths: (stream) =>
          this.provider.state.snapshots.getKnownFilePaths(stream, {
            workspaceOnly: true,
          }),
      },
      executeAgent: async (request) => {
        await this.executeValidated(request);
      },
      runDiff: async (request) => {
        await vscode.commands.executeCommand('texra.runLatexdiff', request);
      },
      runFileOperation: async (operation, request) => {
        await vscode.commands.executeCommand(`texra.${operation}`, request);
      },
    });
  }

  private createWorkflowFileActionsController(): ProgressWorkflowFileActionsController {
    return new ProgressWorkflowFileActionsController({
      state: {
        getActiveStream: () => this.provider.state.activeStream,
        getExecutionId: (stream) =>
          this.provider.state.snapshots.getExecutionId(stream),
        getOutputFiles: (stream) =>
          this.provider.state.snapshots.getOutputFiles(stream),
        getAgentModel: (stream) => {
          const taskState = this.provider.state.snapshots.getTaskState(stream);
          return taskState
            ? {
                agent: taskState.agentConfig.agent,
                model: taskState.agentConfig.model,
              }
            : undefined;
        },
      },
      host: {
        compareFiles: async (baseFile, editedFile) => {
          await vscode.commands.executeCommand(
            'texra.compare',
            pathToLocation(''), // inputFile unused
            pathToLocation(baseFile),
            pathToLocation(editedFile),
          );
        },
        acceptEditedFile: async (baseFile, editedFile, copyMeta) => {
          return vscode.commands.executeCommand<boolean>(
            'texra.acceptEdited',
            pathToLocation(''), // inputFile unused
            pathToLocation(baseFile),
            pathToLocation(editedFile),
            copyMeta,
          );
        },
        mergeFile: async (baseFile, editedFile) => {
          await vscode.commands.executeCommand(
            'texra.merge',
            undefined,
            baseFile,
            editedFile,
          );
        },
        latexdiffFile: async (baseFile, editedFile) => {
          await vscode.commands.executeCommand(
            'texra.latexdiff',
            undefined,
            baseFile,
            editedFile,
          );
        },
        openDirectory: async (directory) => {
          await safeExecuteCommand('revealFileInOS', [
            vscode.Uri.file(directory),
          ]);
        },
        openLabel: async (label) => {
          return (
            (await vscode.commands.executeCommand<boolean>(
              'texra.openLabel',
              label,
              { notifyNotFound: false },
            )) ?? false
          );
        },
        readFile: (file) => flexibleFS.read(createExternalLocation(file)),
        showInfo: async (message) => {
          await vscode.window.showInformationMessage(message);
        },
        showError: async (message) => {
          await vscode.window.showErrorMessage(message);
        },
        logError: (message, error) => {
          this.logger.error(this.channel, message, {
            data: error instanceof Error ? error : undefined,
          });
        },
      },
      sendFollowUp: async (stream, text) => {
        await vscode.commands.executeCommand('texra.sendFollowUp', {
          stream,
          text,
        });
      },
    });
  }

  private createAgentProposalController(): ProgressAgentProposalController {
    return new ProgressAgentProposalController({
      getPendingProposal: (proposalId) =>
        this.provider.getPendingAgentProposal(proposalId),
      restoreTaskState: async (taskState) => {
        return (
          (await vscode.commands.executeCommand<boolean>(
            'texra.restoreState',
            taskState,
          )) === true
        );
      },
      resolveProposal: (proposalId, result) => {
        runCoordinatorBridge.resolveProposal(proposalId, result);
      },
      onMissingProposal: (proposalId) => {
        this.logger.warn(
          this.channel,
          `No pending agent proposal found for setup: ${proposalId}`,
        );
      },
      onInvalidProposal: (issues) => {
        this.logger.warn(this.channel, 'Invalid proposal config', {
          data: { errors: issues },
        });
      },
      onSetupComplete: (proposal) => {
        this.logger.info(
          this.channel,
          `Agent proposal ${proposal.proposalId} set up in main view`,
          {
            data: { agent: proposal.agent },
          },
        );
      },
    });
  }

  private createApiKeyRetryController(): ProgressApiKeyRetryController {
    return new ProgressApiKeyRetryController({
      providers: SecretManager.API_PROVIDERS,
      readKey: (provider) =>
        SecretManager.get(SecretManager.getApiKeySecretName(provider)),
      hasUsableKey: (provider) => SecretManager.hasUsableApiKey(provider),
      promptForApiKey: async (provider) => {
        await vscode.commands.executeCommand(
          apiKeyCommands.setApiKey,
          provider,
        );
      },
      setUseIncludedModelAccess: (enabled) =>
        getServerSideKeyService().setUseIncludedModelAccess(enabled),
      invalidateModelOptionsCache,
      triggerRetry: (stream) => runCoordinatorBridge.triggerRetry(stream),
    });
  }

  private createFollowUpController(): ProgressFollowUpController {
    return new ProgressFollowUpController({
      getAgentCategory: (agent) =>
        getAgent(agent, AgentCategory.ToolUse)?.category,
      workspace: {
        locatePath: (candidate) => WorkspaceFS.locatePath(candidate),
        exists: (relativePath) => WorkspaceFS.exists(relativePath),
      },
    });
  }

  // ============================================================
  // Stream management handlers
  // ============================================================

  private async handleDeleteAll(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      'Are you sure you want to delete all streams? This action cannot be undone.',
      { modal: true },
      'Delete All',
      'Cancel',
    );

    if (confirmation !== 'Delete All') return;
    await this.streamLifecycleController.deleteAllStreams();
  }

  // ============================================================
  // Action handlers
  // ============================================================

  private async handleRetryStreamRequest(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST>,
  ): Promise<void> {
    const success = runCoordinatorBridge.triggerRetry(
      data.stream,
      data.feedback,
    );
    if (!success) {
      await vscode.window.showInformationMessage(
        'No retryable request is available for this stream yet.',
      );
    }
  }

  private async handleUseOwnApiKey(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY>,
  ): Promise<void> {
    const providerArg =
      data.provider !== undefined && isApiProvider(data.provider)
        ? data.provider
        : undefined;

    const result = await this.apiKeyRetryController.useOwnApiKey({
      stream: data.stream,
      provider: providerArg,
      upstreamCreditDepleted: data.upstreamCreditDepleted,
      viaRelay: data.viaRelay,
    });
    if (result.proceeded && !result.retried) {
      await vscode.window.showInformationMessage(
        'Switched to your own API key. No pending retry to resume — run the agent again when ready.',
      );
    }
  }

  private async handlePolishFollowUp(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP>,
  ): Promise<void> {
    const taskState = this.provider.state.snapshots.getTaskState(data.stream);
    if (!taskState) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Polishing follow-up message',
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({
            message: 'Sending to AI for polishing...',
            increment: 30,
          });
          const result = await this.followUpPolishController.polishFollowUp({
            stream: data.stream,
            text: data.text,
            taskState,
          });
          progress.report({
            message: 'Applying changes...',
            increment: 60,
          });
          await this.applyFollowUpPolishResult(result);
        } catch (error) {
          const errorMsg = toErrorMessage(error);
          this.postToActiveView({
            command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
            stream: data.stream,
            kind: 'polishError',
            text: null,
            error: errorMsg,
          });
          await vscode.window.showErrorMessage(
            `Error polishing follow-up: ${errorMsg}`,
          );
          this.logger.error(
            this.channel,
            `Error polishing follow-up: ${errorMsg}`,
            {
              data: error instanceof Error ? error : undefined,
            },
          );
        }
      },
    );
  }

  private async applyFollowUpPolishResult(
    result: ProgressFollowUpPolishResult,
  ): Promise<void> {
    switch (result.kind) {
      case 'skipped':
        return;
      case 'updated':
        this.postToActiveView(result.update);
        return;
      case 'failed':
        this.postToActiveView(result.update);
        await vscode.window.showErrorMessage(result.userMessage);
        return;
      case 'exception':
        this.postToActiveView(result.update);
        await vscode.window.showErrorMessage(result.userMessage);
        this.logger.error(this.channel, result.logMessage, {
          data: result.logData,
        });
        return;
    }
  }

  private handlePlanApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION>,
  ): void {
    const { approvalId, action } = data;
    switch (action) {
      case 'approve':
        runCoordinatorBridge.resolvePlanApproval(approvalId, {
          action: 'approve',
        });
        break;
      case 'approve_and_goal':
        runCoordinatorBridge.resolvePlanApproval(approvalId, {
          action: 'approve_and_goal',
        });
        break;
      case 'reject':
        runCoordinatorBridge.resolvePlanApproval(approvalId, {
          action: 'reject',
          feedback: data.feedback,
        });
        break;
    }
  }

  // ============================================================
  // Helper methods
  // ============================================================

  /**
   * Validate and execute an agent request.
   * Returns true if execution started, false if validation failed.
   */
  private async executeValidated(request: ExecutionRequest): Promise<boolean> {
    const validation = validateExecutionRequest(request);
    if (!validation.valid) {
      this.logger.error(this.channel, validation.message);
      return false;
    }
    await safeExecuteCommand('texra.execute', [validation.request]);
    return true;
  }

  private async handleGetFollowupOptions(streamId: StreamTabId): Promise<void> {
    const { agentOptions, modelOptions } = await loadOptions();
    this.postToActiveView({
      command: PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS,
      stream: streamId,
      toolUseAgentsData: agentOptions.toolUse,
      modelOptionsData: modelOptions,
    });
  }

  private async processToolUseFollowup(
    data:
      | MessageFor<typeof PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP>
      | MessageFor<typeof PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP>,
    executeImmediately: boolean,
  ): Promise<void> {
    const taskState = this.provider.state.snapshots.getTaskState(data.stream);
    const outputFiles = [
      ...this.provider.state.snapshots.getOutputFiles(data.stream).values(),
    ].flat();
    const { modelOptions } = await loadOptions();

    await this.applyFollowUpPlan(
      this.followUpController.planToolUseFollowUp({
        streamId: data.stream,
        taskState,
        outputFiles,
        agent: data.agent,
        model: data.model,
        initialQuestion: data.initialQuestion,
        executeImmediately,
        modelOptions,
        executionId: this.provider.state.snapshots.getExecutionId(data.stream),
      }),
    );
  }

  private async handleRunCompileFixer(streamId: StreamTabId): Promise<void> {
    const taskState = this.provider.state.snapshots.getTaskState(streamId);
    const compileFailures = [
      ...this.provider.state.snapshots.getCompileFailures(streamId).values(),
    ].flat();
    const { modelOptions } = await loadOptions();

    await this.applyFollowUpPlan(
      await this.followUpController.planCompileFixer({
        streamId,
        taskState,
        compileFailures,
        runOutputs: this.provider.state.snapshots.getOutputFiles(streamId),
        modelOptions,
        executionId: this.provider.state.snapshots.getExecutionId(streamId),
      }),
    );
  }

  private async applyFollowUpPlan(plan: ProgressFollowUpPlan): Promise<void> {
    switch (plan.kind) {
      case 'warning':
        await vscode.window.showWarningMessage(plan.message);
        return;
      case 'info':
        await vscode.window.showInformationMessage(plan.message);
        return;
      case 'restoreState':
        await vscode.commands.executeCommand(
          'texra.restoreState',
          plan.taskState,
          plan.executeImmediately,
        );
        return;
      case 'execute':
        await this.executeValidated(plan.request);
    }
  }
}
