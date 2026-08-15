import * as vscode from 'vscode';

import { defaultSession } from '@agent/runtime';
import {
  validateExecutionRequest,
  type ExecutionRequest,
} from '@agent/core/state/executionRequests';
import { getServerSideKeyService } from '@auth/serverKeys';
import { apiKeyCommands } from '@commands/api/apiKeyCommands';
import { BaseViewMessageHandler } from '@common/webview';
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';
import {
  ProgressFollowUpPolishController,
  type ProgressFollowUpPolishResult,
} from '@controllers/progressView/ProgressFollowUpPolishController';
import {
  ProgressFollowUpController,
  type ProgressFollowUpPlan,
} from '@controllers/progressView/ProgressFollowUpController';
import type { ProgressHostInteractions } from '@controllers/progressView/backend/progressHostInteractions';
import { ProgressWorkflowActionsController } from '@controllers/progressView/ProgressWorkflowActionsController';
import { ProgressViewHost } from '@controllers/progressView/ProgressViewHost';
import {
  createProgressViewSecondTierHandlers,
  type ProgressViewSecondTierActions,
} from '@controllers/progressView/ProgressViewCommandHandlers';
import { SecretManager } from '@frontend/secretManager';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { RecordingManager } from '@frontend/media/RecordingManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import type { PromptHost } from '@hosts/uiHosts';
import { apiKeySecretName } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { getRuntimeModelDirectFallback } from '@model/runtimeModelRegistry';
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import { platform } from '@platform/platform';
import type { GettingStartedAction, StreamTabId } from '@shared/schemas';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { unsupportedCommands } from '@shared/utils/dispatcher';
import {
  dispatchProgressViewInbound,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { GETTING_STARTED_COMMANDS } from '@shared/schemas/mainView';
import {
  cleanupUnscopedApprovals,
  releaseStreamResources,
} from '@tools/approval';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  private readonly workflowActionsController: ProgressWorkflowActionsController;
  private readonly apiKeyRetryController: ProgressApiKeyRetryController;
  private readonly followUpController: ProgressFollowUpController;
  private readonly followUpPolishController: ProgressFollowUpPolishController;

  /**
   * Type-safe handler registry - handlers receive typed data.
   */
  private readonly handlerRegistry: ProgressViewInboundHandlerRegistry;

  /** The one info-notification adapter the controller ports are wired to. */
  private readonly showInfo = async (message: string): Promise<void> => {
    await this.host.info(message);
  };

  constructor(
    private readonly provider: ProgressViewProvider,
    private readonly host: PromptHost,
    private readonly interactions: ProgressHostInteractions,
  ) {
    super('ProgressView');

    this.recordingManager = new RecordingManager({
      buildRecordingMessage: (message) => ({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING,
        ...message,
      }),
      buildTranscriptionMessage: (text) => ({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
        kind: 'transcribed',
        text,
      }),
      progressTitle: 'Transcribing follow-up message',
    });

    this.workflowActionsController = this.createWorkflowActionsController();
    this.progressHost = this.createProgressViewHost();
    this.apiKeyRetryController = this.createApiKeyRetryController();
    this.followUpController = this.createFollowUpController();
    this.followUpPolishController = new ProgressFollowUpPolishController();
    this.handlerRegistry = this.createHandlerRegistry();
  }

  public async stopStream(
    stream: StreamTabId,
    options: { clearRetryRequest?: boolean } = {},
  ): Promise<void> {
    if (options.clearRetryRequest === true) {
      this.interactions.cancel({
        streamId: stream,
        kind: 'retry',
        cause: 'Retry request cleared.',
      });
    }
    // Deletion must stop if the command fails; safeExecuteCommand intentionally
    // absorbs errors for ordinary view actions.
    await vscode.commands.executeCommand('texra.stopAgent', stream);
  }

  public cleanupDeletedStream(stream: StreamTabId): void {
    releaseStreamResources(stream);
    this.progressHost.workflowFileActionsController.clearStreamBackups(stream);
  }

  public cleanupDeletedStreams(options: { allDeleted: boolean }): void {
    if (!options.allDeleted) return;
    cleanupUnscopedApprovals();
    this.interactions.cancel({ cause: 'All streams deleted.' });
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
    // Set for the duration of a POLISH_FOLLOW_UP notification below, so the
    // shared handler's stage reports land in the open progress notification.
    let polishProgress: vscode.Progress<{ message?: string }> | undefined;

    const secondTierActions: ProgressViewSecondTierActions = {
      getRunMetadata: (stream) =>
        this.provider.state.snapshots.getRunMetadata(stream),
      workflowActions: this.workflowActionsController,
      apiKeyRetry: this.apiKeyRetryController,
      followUp: this.followUpController,
      followUpPolish: this.followUpPolishController,
      host: { showInfo: this.showInfo },
      session: defaultSession(),
      getRunConfig: (stream) =>
        this.provider.state.snapshots.getRunMetadata(stream).config,
      restoreRunConfig: async (config) => {
        await this.runViewCommand('texra.restoreState', [config]);
      },
      applyFollowUpPlan: async (plan) => {
        await this.applyFollowUpPlan(plan);
      },
      applyPolishResult: async (result) => {
        await this.applyFollowUpPolishResult(result);
      },
      onPolishProgress: (message) => {
        polishProgress?.report({ message });
      },
      onPolishError: (stream, error) => this.reportPolishError(stream, error),
      postToRenderer: (message) => {
        this.postToActiveView(message);
      },
      restoreProposalConfig: async (proposal) => {
        const restored =
          await this.progressHost.agentProposalController.restoreProposalConfig(
            proposal,
          );
        if (!restored) return;
        this.logger.info(
          this.channel,
          'Restored proposal config to main view',
          {
            data: {
              agent: proposal.agent,
              agentCategory: proposal.agentCategory,
            },
          },
        );
      },
      retry: {
        submit: (stream, requestId, feedback) =>
          this.interactions.submitRetryDecision(stream, requestId, {
            action: 'retry',
            feedback,
          }),
        cancel: (stream, requestId) => {
          this.interactions.submitRetryDecision(stream, requestId, {
            action: 'cancel',
          });
        },
      },
    };

    const secondTierHandlers =
      createProgressViewSecondTierHandlers(secondTierActions);

    return {
      // Common handlers - passthrough to webview
      [PROGRESS_VIEW_COMMANDS.WEBVIEW_READY]: async () => {
        this.logger.debug(this.channel, 'Webview ready signal received');
        const view = this.getActiveView();
        if (view) {
          await this.provider.markWebviewReady(view);
        }
      },
      [COMMON_COMMANDS.SWITCH_VIEW]: (data) => this.switchView(data),
      [PROGRESS_VIEW_COMMANDS.POP_OUT]: () => this.provider.popOutToEditor(),
      [PROGRESS_VIEW_COMMANDS.POP_BACK]: () => this.provider.showInSidebar(),

      // First-tier shared progress command groups
      ...this.progressHost.commandHandlers,

      // Second-tier shared progress command groups
      ...secondTierHandlers,

      // Override USE_OWN_API_KEY: the shared handler owns the generic case;
      // the extension adds VS Code-specific Copilot-subscription fallback
      // (`startCopilotFallbackRun`) ahead of it.
      [PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY]: async (data) => {
        if (data.exhaustionReason === 'copilot-subscription') {
          await this.startCopilotFallbackRun(data);
          return;
        }
        await secondTierHandlers[PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY](data);
      },
      // Override POLISH_FOLLOW_UP: the shared handler owns the whole flow; the
      // extension only wraps it in a VS Code progress notification and feeds
      // the shared handler's stage reports into it.
      [PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP]: async (data) => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Polishing follow-up message',
            cancellable: false,
          },
          async (progress) => {
            polishProgress = progress;
            try {
              await secondTierHandlers[PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP](
                data,
              );
            } finally {
              if (polishProgress === progress) polishProgress = undefined;
            }
          },
        );
      },

      // Recording (host-specific: extension wraps in a webview-bound
      // RecordingManager that posts status internally)
      [PROGRESS_VIEW_COMMANDS.START_RECORDING]: async () => {
        const view = this.getActiveView();
        if (view) await this.recordingManager.start(view);
      },
      [PROGRESS_VIEW_COMMANDS.STOP_RECORDING]: async () => {
        const view = this.getActiveView();
        if (view) await this.recordingManager.stop(view);
      },

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

  private createProgressViewHost(): ProgressViewHost {
    return new ProgressViewHost({
      run: {
        state: {
          getRunMetadata: (stream) =>
            this.provider.state.snapshots.getRunMetadata(stream),
        },
        // Workflow actions intentionally wait for the run to finish.
        runExecutionRequest: (request) => this.executeValidated(request),
      },
      workflowFileActions: {
        state: {
          getActiveStream: () =>
            this.provider.backend.presentation.activeStream,
          getRunMetadata: (stream) =>
            this.provider.state.snapshots.getRunMetadata(stream),
          getOutputFiles: (stream) =>
            this.provider.state.snapshots.getOutputFiles(stream),
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
          readFile: (file) => AbsoluteFS.read(file),
          showInfo: this.showInfo,
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
        restoreRunConfig: async (config) => {
          return (
            (await this.runViewCommand<boolean>('texra.restoreState', [
              config,
            ])) === true
          );
        },
        openFile: async (file) => {
          await this.runViewCommand('texra.openFile', [file]);
        },
        settleProposal: (proposalId, result) => {
          const resolved = this.interactions.submitProposalDecision(
            proposalId,
            result,
          );
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
          setActiveStream: (stream, requestId) =>
            this.provider.setActiveStream(stream, requestId),
          deleteStream: (stream) => this.provider.backend.deleteStream(stream),
          deleteAllStreams: () => this.handleDeleteAll(),
          stopStream: (stream) => this.provider.backend.stopStream(stream),
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
          showInfo: this.showInfo,
        },
        file: {
          openFile: async (file, line) => {
            await this.runViewCommand('texra.openFile', [file, line]);
          },
        },
        approval: {
          approvePendingDelegatedWork: (stream, initiatingProposalId) =>
            this.interactions.approvePendingDelegatedWork(
              stream,
              initiatingProposalId,
            ),
          handleToolEditApprovalAction: (message) =>
            this.provider.toolEditApprovals.handleAction(message),
          handleBashApprovalAction: (message) =>
            this.handleBashApprovalAction(message),
          handlePlanApprovalAction: (message) =>
            this.handlePlanApprovalAction(message),
          handleUserQuestionAction: (message) =>
            this.handleUserQuestionAction(message),
        },
        externalInquiry: {
          dismiss: (threadId) =>
            this.interactions.dismissExternalInquiry(threadId),
        },
      },
    });
  }

  private createWorkflowActionsController(): ProgressWorkflowActionsController {
    return new ProgressWorkflowActionsController({
      state: {
        getRunMetadata: (stream) =>
          this.provider.state.snapshots.getRunMetadata(stream),
        getOutputFiles: (stream) =>
          this.provider.state.snapshots.getOutputFiles(stream),
        getKnownWorkspaceOutputPaths: (stream) =>
          this.provider.state.snapshots.getKnownFilePaths(stream, {
            workspaceOnly: true,
          }),
      },
      runDiff: async (request) => {
        await this.runViewCommand('texra.runLatexdiff', [request]);
      },
      runFileOperation: async (operation, request) => {
        await this.runViewCommand(`texra.${operation}`, [request]);
      },
    });
  }

  private createApiKeyRetryController(): ProgressApiKeyRetryController {
    return new ProgressApiKeyRetryController({
      providers: SecretManager.API_PROVIDERS,
      readKey: (provider) => platform().secrets.get(apiKeySecretName(provider)),
      hasUsableKey: (provider) => SecretManager.hasUsableApiKey(provider),
      promptForApiKey: async (provider) => {
        await this.runViewCommand(apiKeyCommands.setApiKey, [provider]);
      },
      getUseIncludedModelAccess: () =>
        getServerSideKeyService().getUseIncludedModelAccess(),
      setUseIncludedModelAccess: (enabled) =>
        getServerSideKeyService().setUseIncludedModelAccess(enabled),
      getPreferChatGptSubscription: isPreferCodexSubscription,
      setPreferChatGptSubscription: async (enabled) => {
        await setPreferCodexSubscription(enabled);
      },
      invalidateModelOptionsCache,
      isRetryPending: (stream, requestId) =>
        this.interactions.isRetryPending(stream, requestId),
      triggerRetry: (stream, requestId) =>
        this.interactions.submitRetryWithPersonalCredentials(stream, requestId),
    });
  }

  private createFollowUpController(): ProgressFollowUpController {
    return new ProgressFollowUpController({
      loadModelOptions: async () => {
        const { modelOptionsByCategory } = await loadOptions();
        return modelOptionsByCategory.workflow;
      },
      state: {
        getRunMetadata: (stream) =>
          this.provider.state.snapshots.getRunMetadata(stream),
        getOutputFiles: (stream) =>
          this.provider.state.snapshots.getOutputFiles(stream),
        getCompileFailures: (stream) =>
          this.provider.state.snapshots.getCompileFailures(stream),
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
    await this.provider.backend.deleteAllStreams();
  }

  // ============================================================
  // Action handlers
  // ============================================================

  private handleBashApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION>,
  ): void {
    this.interactions.submitBashDecision(
      data.requestId,
      data.action === 'approve'
        ? { action: 'approve' }
        : { action: 'reject', feedback: data.feedback },
    );
  }

  private handleUserQuestionAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION>,
  ): void {
    this.interactions.submitUserQuestionDecision(
      data.requestId,
      data.action === 'submit'
        ? { action: 'submit', answers: data.answers }
        : { action: data.action, feedback: data.feedback },
    );
  }

  private async startCopilotFallbackRun(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY>,
  ): Promise<void> {
    if (!this.interactions.isRetryPending(data.stream, data.requestId)) return;

    const chooseAnotherModel =
      'Choose another model and start the agent again.';
    const modelsChanged =
      'The available models changed while TeXRA was preparing the API key. Try again.';

    if (!data.model) {
      await this.host.info(
        `TeXRA did not record which Copilot model this retry used. ${chooseAnotherModel}`,
      );
      return;
    }

    let fallback = getRuntimeModelDirectFallback(
      data.model,
      getUseOpenRouter(),
    );
    if (!fallback) {
      await this.host.info(
        `No model you can use with your own API key matches this Copilot model. ${chooseAnotherModel}`,
      );
      return;
    }

    // Key entry can outlive the retry panel, and the user can change the
    // OpenRouter preference while that prompt is open. Revalidate both the
    // exact retry identity and the effective credential owner after each
    // prompt so an old action cannot launch or alter a replacement request.
    let prepared = await this.apiKeyRetryController.ensureOwnApiKey({
      provider: fallback.provider,
      exhaustionReason: data.exhaustionReason,
      viaRelay: data.viaRelay,
    });
    if (!prepared) return;
    if (!this.interactions.isRetryPending(data.stream, data.requestId)) return;

    const currentFallback = getRuntimeModelDirectFallback(
      data.model,
      getUseOpenRouter(),
    );
    if (!currentFallback) {
      await this.host.info(modelsChanged);
      return;
    }
    if (currentFallback.provider !== fallback.provider) {
      fallback = currentFallback;
      prepared = await this.apiKeyRetryController.ensureOwnApiKey({
        provider: fallback.provider,
        exhaustionReason: data.exhaustionReason,
        viaRelay: data.viaRelay,
      });
      if (!prepared) return;
      if (!this.interactions.isRetryPending(data.stream, data.requestId)) {
        return;
      }
      const finalFallback = getRuntimeModelDirectFallback(
        data.model,
        getUseOpenRouter(),
      );
      if (!finalFallback || finalFallback.provider !== fallback.provider) {
        await this.host.info(modelsChanged);
        return;
      }
    }

    const { config } = this.provider.state.snapshots.getRunMetadata(
      data.stream,
    );
    if (!config) {
      await this.host.info(
        `The settings for this run are no longer available. ${chooseAnotherModel}`,
      );
      return;
    }

    const started =
      await this.apiKeyRetryController.runCopilotFallbackWithRouting(
        {
          provider: fallback.provider,
          model: fallback.model,
          exhaustionReason: data.exhaustionReason,
          chatGptSubscriptionEligible: fallback.chatGptSubscriptionEligible,
          viaRelay: data.viaRelay,
        },
        async (copilotRouteOverride) => {
          if (!this.interactions.isRetryPending(data.stream, data.requestId)) {
            return false;
          }
          return this.executeValidatedUntilStarted(
            { config: { ...config, model: fallback.model } },
            { copilotRouteOverride },
          );
        },
      );
    if (!started) return;

    this.interactions.submitRetryDecision(data.stream, data.requestId, {
      action: 'cancel',
    });
  }

  /** Post the polish failure to the renderer, surface it, and log it. */
  private reportPolishError(stream: StreamTabId, error: unknown): void {
    const errorMsg = toErrorMessage(error);
    this.postToActiveView({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
      stream,
      kind: 'polishError',
      text: null,
      error: errorMsg,
    });
    void this.host.error(`Could not polish the follow-up: ${errorMsg}`);
    this.logger.error(this.channel, `Error polishing follow-up: ${errorMsg}`, {
      data: error instanceof Error ? error : undefined,
    });
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
        this.logger.error(this.channel, result.logMessage, {
          data: result.logData,
        });
        await this.host.error(result.userMessage);
        return;
    }
  }

  private handlePlanApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION>,
  ): void {
    const { approvalId, action } = data;
    this.interactions.submitPlanDecision(
      approvalId,
      action === 'reject'
        ? { action: 'reject', feedback: data.feedback }
        : { action },
    );
  }

  // ============================================================
  // Helper methods
  // ============================================================

  /**
   * Validate an agent request and run it. Both callers own their own
   * user-facing failure reporting, so a rejected request is only logged.
   */
  private async executeValidated(
    request: ExecutionRequest,
    options: { preferHelperModel?: boolean } = {},
  ): Promise<void> {
    const validation = validateExecutionRequest(request);
    if (!validation.valid) {
      this.logger.error(this.channel, validation.message);
      return;
    }
    await this.runViewCommand('texra.execute', [
      options.preferHelperModel
        ? { ...validation.request, preferHelperModel: true }
        : validation.request,
    ]);
  }

  /** Validate a request and acknowledge it once the runtime owns a run handle. */
  private async executeValidatedUntilStarted(
    request: ExecutionRequest,
    options: { copilotRouteOverride?: 'direct' } = {},
  ): Promise<boolean> {
    const validation = validateExecutionRequest(request);
    if (!validation.valid) {
      this.logger.error(this.channel, validation.message);
      return false;
    }

    // Whichever of `onRun` and the command's own settlement lands first wins:
    // a promise ignores every resolve after the first.
    return new Promise<boolean>((resolve) => {
      void this.runViewCommand<boolean>('texra.execute', [
        {
          ...validation.request,
          ...options,
          onRun: () => resolve(true),
        },
      ]).then(
        (completed) => resolve(completed === true),
        () => resolve(false),
      );
    });
  }

  private async applyFollowUpPlan(plan: ProgressFollowUpPlan): Promise<void> {
    switch (plan.kind) {
      case 'warning':
        await this.host.warning(plan.message);
        return;
      case 'info':
        await this.host.info(plan.message);
        return;
      case 'execute':
        // Follow-up 'execute' plans are the compile fixer (latexFixer), so run
        // them on the configured helper model.
        await this.executeValidated(plan.request, { preferHelperModel: true });
    }
  }
}
