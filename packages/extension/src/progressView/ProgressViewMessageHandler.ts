import * as vscode from 'vscode';

import { ProgressViewHost } from '@controllers/progressView/ProgressViewHost';
import { ProgressStreamLifecycleController } from '@controllers/progressView/ProgressStreamLifecycleController';
import {
  ProgressFollowUpController,
  type ProgressFollowUpPlan,
} from '@controllers/progressView/ProgressFollowUpController';
import {
  ProgressFollowUpPolishController,
  type ProgressFollowUpPolishResult,
} from '@controllers/progressView/ProgressFollowUpPolishController';
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';
import { getAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  validateExecutionRequest,
  type ExecutionRequest,
} from '@agent/core/state/executionRequests';
import { getServerSideKeyService } from '@auth/serverKeys';
import { setPreferCodexSubscription } from '@auth/codex';
import { apiKeyCommands } from '@commands/api/apiKeyCommands';
import { BaseViewMessageHandler } from '@common/webview';
import { SecretManager } from '@frontend/secretManager';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { handleProgressViewToolEditApprovalAction } from '@frontend/approval/nativeToolEditApproval';
import { RecordingManager } from '@frontend/media/RecordingManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import type { PromptHost } from '@hosts/uiHosts';
import { isApiProvider } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { GettingStartedAction, StreamTabId } from '@shared/schemas';
import { GETTING_STARTED_COMMANDS } from '@shared/schemas/mainView';
import { isGoalInFlight } from '@shared/schemas/goal';
import {
  dispatchProgressViewInbound,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { unsupportedCommands } from '@shared/utils/dispatcher';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';
import {
  createExternalLocation,
  FlexibleFS,
  pathToLocation,
  WorkspaceFS,
} from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  private readonly progressHost: ProgressViewHost;
  private readonly streamLifecycleController: ProgressStreamLifecycleController;
  private readonly workflowActionsController: ProgressViewHost['workflowActionsController'];
  private readonly workflowFileActionsController: ProgressViewHost['workflowFileActionsController'];
  private readonly agentProposalController: ProgressViewHost['agentProposalController'];
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
    private readonly host: PromptHost,
    private readonly interactions: HostInteractions,
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

    this.progressHost = this.createProgressViewHost();
    this.workflowActionsController =
      this.progressHost.workflowActionsController;
    this.workflowFileActionsController =
      this.progressHost.workflowFileActionsController;
    this.agentProposalController = this.progressHost.agentProposalController;
    this.streamLifecycleController = this.createStreamLifecycleController();
    this.apiKeyRetryController = this.createApiKeyRetryController();
    this.followUpController = this.createFollowUpController();
    this.followUpPolishController = new ProgressFollowUpPolishController();
    this.handlerRegistry = this.createHandlerRegistry();

    const unsubscribeGoal = subscribeGoalStateChanges(
      defaultSession(),
      ({ streamId }) => {
        const goal = GoalStore.getForStream(streamId);
        this.provider.webviewUpdater.updateGoalActive(
          streamId,
          isGoalInFlight(goal),
          { status: goal?.status, objective: goal?.objective },
        );
      },
    );
    context.subscriptions.push({ dispose: unsubscribeGoal });
  }

  public removeStreamFromHost(streamId: StreamTabId): Promise<void> {
    return this.streamLifecycleController.deleteStream(streamId);
  }

  /** Execute a VS Code command, routing failures through this view's error channel. */
  private runViewCommand<T = void>(
    command: string,
    args: unknown[] = [],
  ): Promise<T | undefined> {
    return safeExecuteCommand<T>(command, args, this.viewName);
  }

  /**
   * Create the typed handler registry.
   * Each handler receives typed data - no casts or validation needed.
   */
  private createHandlerRegistry(): ProgressViewInboundHandlerRegistry {
    const forwardToActiveView = (message: ProgressViewInboundMessage) => {
      this.postToActiveView(message);
    };
    const runCommand = (command: string, ...args: unknown[]) => {
      return async () => {
        await this.runViewCommand(command, args);
      };
    };

    return {
      // Common handlers - passthrough to webview
      [PROGRESS_VIEW_COMMANDS.WEBVIEW_READY]: async () => {
        this.logger.debug(this.channel, 'Webview ready signal received');
        const view = this.getActiveView();
        if (view) {
          await this.provider.markWebviewReady(view);
        }
      },
      [PROGRESS_VIEW_COMMANDS.THEME_SET]: forwardToActiveView,
      [PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET]: forwardToActiveView,
      [COMMON_COMMANDS.SWITCH_VIEW]: (data) => this.switchView(data),
      [PROGRESS_VIEW_COMMANDS.POP_OUT]: () => this.provider.popOutToEditor(),
      [PROGRESS_VIEW_COMMANDS.POP_BACK]: () => this.provider.popBackToSidebar(),

      // Shared progress command groups
      ...this.progressHost.commandHandlers,
      [PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE]: async (data) => {
        await this.runViewCommand('texra.compactResponse', [data.stream]);
      },

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
        this.handleCancelRetryRequest(data);
      },
      [PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY]: (data) =>
        this.handleUseOwnApiKey(data),
      [PROGRESS_VIEW_COMMANDS.RESTORE_STATE]: async (data) => {
        const taskState = this.provider.state.snapshots.getTaskState(
          data.stream,
        );
        if (taskState) {
          await this.runViewCommand('texra.restoreState', [taskState]);
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
        await this.host.info(data.text);
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
      // Profile & Memory - direct command execution
      [PROGRESS_VIEW_COMMANDS.OPEN_PROFILE]: runCommand(
        'texra.auth.viewProfile',
      ),
      [PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW]: runCommand('texra.showMemory'),

      // Followup task
      [PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS]: (data) =>
        this.handleGetFollowupOptions(data.stream),
      [PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP]: (data) =>
        this.processToolUseFollowup(data, false),
      [PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP]: (data) =>
        this.processToolUseFollowup(data, true),
      [PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER]: (data) =>
        this.handleRunCompileFixer(data.stream),

      [PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION]: (data) =>
        this.runGettingStartedAction(data.action),
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

  /**
   * Commands this registry declares `unsupported(...)`, for the derived
   * frontend capability view (see `ProgressBackendOptions.getUnsupportedCommands`).
   */
  public getUnsupportedCommands(): string[] {
    return unsupportedCommands(this.handlerRegistry);
  }

  private async switchView(
    data: MessageFor<typeof COMMON_COMMANDS.SWITCH_VIEW>,
  ): Promise<void> {
    if (data.view === 'dashboard') {
      await this.runViewCommand('texra.showDashboard');
      return;
    }
    if (data.view === 'main') {
      await this.runViewCommand('texra.showMainView');
      return;
    }
    if (data.openInEditor) {
      await this.provider.popOutToEditor();
      return;
    }
    await this.runViewCommand('texra.showProgressView');
  }

  private async runGettingStartedAction(
    action: GettingStartedAction,
  ): Promise<void> {
    await this.runViewCommand(GETTING_STARTED_COMMANDS[action]);
    if (action === 'runSetup') {
      await this.provider.refreshOnboardingFunnel();
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
        this.interactions,
      ),
    });
  }

  private createProgressViewHost(): ProgressViewHost {
    return new ProgressViewHost({
      workflowActions: {
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
          await this.runViewCommand('texra.runLatexdiff', [request]);
        },
        runFileOperation: async (operation, request) => {
          await this.runViewCommand(`texra.${operation}`, [request]);
        },
      },
      workflowFileActions: {
        state: {
          getActiveStream: () => this.provider.state.activeStream,
          getExecutionId: (stream) =>
            this.provider.state.snapshots.getExecutionId(stream),
          getOutputFiles: (stream) =>
            this.provider.state.snapshots.getOutputFiles(stream),
          getAgentModel: (stream) => {
            const taskState =
              this.provider.state.snapshots.getTaskState(stream);
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
            await this.runViewCommand('texra.compare', [
              pathToLocation(''), // inputFile unused
              pathToLocation(baseFile),
              pathToLocation(editedFile),
            ]);
          },
          acceptEditedFile: async (baseFile, editedFile, copyMeta) => {
            return this.runViewCommand<boolean>('texra.acceptEdited', [
              pathToLocation(''), // inputFile unused
              pathToLocation(baseFile),
              pathToLocation(editedFile),
              copyMeta,
            ]);
          },
          mergeFile: async (baseFile, editedFile) => {
            await this.runViewCommand('texra.merge', [
              undefined,
              baseFile,
              editedFile,
            ]);
          },
          latexdiffFile: async (baseFile, editedFile) => {
            await this.runViewCommand('texra.latexdiff', [
              undefined,
              baseFile,
              editedFile,
            ]);
          },
          openDirectory: async (directory) => {
            await this.runViewCommand('revealFileInOS', [
              vscode.Uri.file(directory),
            ]);
          },
          openLabel: async (label) => {
            return (
              (await this.runViewCommand<boolean>('texra.openLabel', [
                label,
                { notifyNotFound: false },
              ])) ?? false
            );
          },
          readFile: (file) => FlexibleFS.read(createExternalLocation(file)),
          showInfo: async (message) => {
            await this.host.info(message);
          },
          showError: async (message) => {
            await this.host.error(message);
          },
          logError: (message, error) => {
            this.logger.error(this.channel, message, {
              data: error instanceof Error ? error : undefined,
            });
          },
        },
        sendFollowUp: async (stream, text) => {
          await this.runViewCommand('texra.sendFollowUp', [{ stream, text }]);
        },
      },
      agentProposal: {
        getPendingProposal: (proposalId) =>
          this.provider.getPendingAgentProposal(proposalId),
        restoreTaskState: async (taskState) => {
          return (
            (await this.runViewCommand<boolean>('texra.restoreState', [
              taskState,
            ])) === true
          );
        },
        settleProposal: (proposalId, result) => {
          const resolved = this.interactions.resolve(proposalId, {
            kind: 'proposal',
            action: result.action,
            value: result,
          });
          if (!resolved) {
            this.logger.warn(
              this.channel,
              `No pending host interaction found for proposal: ${proposalId}`,
            );
          }
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
      },
      commands: {
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
        followUp: {
          sendFollowUp: async ({ stream, text, mediaFiles }) => {
            await this.runViewCommand('texra.sendFollowUp', [
              {
                stream,
                text,
                ...(mediaFiles && mediaFiles.length > 0 ? { mediaFiles } : {}),
              },
            ]);
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
          showInfo: (message) => this.host.info(message),
        },
        file: {
          openFile: async (file, line) => {
            await this.runViewCommand('texra.openFile', [file, line]);
          },
          openFileCompile: async (file) => {
            await this.runViewCommand('texra.openFileCompile', [file]);
          },
        },
        approval: {
          handleToolEditApprovalAction: async (message) => {
            await handleProgressViewToolEditApprovalAction(message);
            return true;
          },
          handleBashApprovalAction: (message) =>
            this.handleBashApprovalAction(message),
          handlePlanApprovalAction: (message) =>
            this.handlePlanApprovalAction(message),
          handleUserQuestionAction: (message) =>
            this.handleUserQuestionAction(message),
        },
        externalInquiry: {},
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
        await this.runViewCommand(apiKeyCommands.setApiKey, [provider]);
      },
      setUseIncludedModelAccess: (enabled) =>
        getServerSideKeyService().setUseIncludedModelAccess(enabled),
      disablePreferCodexSubscription: async () => {
        await setPreferCodexSubscription(false);
      },
      invalidateModelOptionsCache,
      triggerRetry: (stream) =>
        this.interactions.resolve(stream, { kind: 'retry', action: 'retry' }),
    });
  }

  private createFollowUpController(): ProgressFollowUpController {
    return new ProgressFollowUpController({
      getAgentCategory: (agent) =>
        getAgent(agent, AgentCategory.ToolUse)?.category,
      loadModelOptions: async () => {
        const { modelOptions } = await loadOptions();
        return modelOptions;
      },
      state: {
        getTaskState: (stream) =>
          this.provider.state.snapshots.getTaskState(stream),
        getOutputFiles: (stream) =>
          this.provider.state.snapshots.getOutputFiles(stream),
        getCompileFailures: (stream) =>
          this.provider.state.snapshots.getCompileFailures(stream),
        getExecutionId: (stream) =>
          this.provider.state.snapshots.getExecutionId(stream),
      },
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
    const confirmation = await this.host.warning<'Delete All' | 'Cancel'>(
      'Are you sure you want to delete all streams? This action cannot be undone.',
      {
        modal: true,
        items: ['Delete All', { label: 'Cancel', isCloseAffordance: true }],
      },
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
    const resolved = this.interactions.resolve(data.stream, {
      kind: 'retry',
      action: 'retry',
      feedback: data.feedback,
    });
    if (!resolved) {
      await this.host.info(
        'No retryable request is available for this stream yet.',
      );
    }
  }

  private handleCancelRetryRequest(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST>,
  ): void {
    this.interactions.resolve(data.stream, {
      kind: 'retry',
      action: 'cancel',
    });
  }

  private handleBashApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION>,
  ): void {
    this.interactions.resolve(data.requestId, {
      kind: 'bash',
      action: data.action,
      feedback: data.feedback,
    });
  }

  private handleUserQuestionAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION>,
  ): void {
    this.interactions.resolve(data.requestId, {
      kind: 'userQuestion',
      action: data.action,
      value: data.answers,
      feedback: data.feedback,
    });
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
      chatgptSubscription: data.chatgptSubscription,
    });
    if (result.proceeded && !result.retried) {
      await this.host.info(
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
          await this.host.error(`Error polishing follow-up: ${errorMsg}`);
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
        await this.host.error(result.userMessage);
        return;
      case 'exception':
        this.postToActiveView(result.update);
        await this.host.error(result.userMessage);
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
    this.interactions.resolve(approvalId, {
      kind: 'plan',
      action,
      feedback: data.feedback,
    });
  }

  // ============================================================
  // Helper methods
  // ============================================================

  /**
   * Validate and execute an agent request.
   * Returns true if execution started, false if validation failed.
   */
  private async executeValidated(
    request: ExecutionRequest,
    options: { preferHelperModel?: boolean } = {},
  ): Promise<boolean> {
    const validation = validateExecutionRequest(request);
    if (!validation.valid) {
      this.logger.error(this.channel, validation.message);
      return false;
    }
    await this.runViewCommand('texra.execute', [
      options.preferHelperModel
        ? { ...validation.request, preferHelperModel: true }
        : validation.request,
    ]);
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
    await this.applyFollowUpPlan(
      await this.followUpController.planToolUseFollowUpForStream({
        streamId: data.stream,
        agent: data.agent,
        model: data.model,
        initialQuestion: data.initialQuestion,
        executeImmediately,
      }),
    );
  }

  private async handleRunCompileFixer(streamId: StreamTabId): Promise<void> {
    await this.applyFollowUpPlan(
      await this.followUpController.planCompileFixerForStream(streamId),
    );
  }

  private async applyFollowUpPlan(plan: ProgressFollowUpPlan): Promise<void> {
    switch (plan.kind) {
      case 'warning':
        await this.host.warning(plan.message);
        return;
      case 'info':
        await this.host.info(plan.message);
        return;
      case 'restoreState':
        await this.runViewCommand('texra.restoreState', [
          plan.taskState,
          plan.executeImmediately,
        ]);
        return;
      case 'execute':
        // Follow-up 'execute' plans are the compile fixer (latexFixer), so run
        // them on the configured helper model.
        await this.executeValidated(plan.request, { preferHelperModel: true });
    }
  }
}
