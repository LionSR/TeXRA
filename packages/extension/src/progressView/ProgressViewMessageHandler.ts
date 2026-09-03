import * as path from 'node:path';
import * as vscode from 'vscode';

import { defaultSession } from '@agent/runtime';
import {
  validateExecutionRequest,
  type ExecutionRequest,
} from '@agent/core/state/executionRequests';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { BaseViewMessageHandler } from '@common/webview';
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';
import { ProgressFollowUpPolishController } from '@controllers/progressView/ProgressFollowUpPolishController';
import { ProgressFollowUpController } from '@controllers/progressView/ProgressFollowUpController';
import {
  applyFollowUpPlan,
  applyFollowUpPolishResult,
  type FollowUpApplyPorts,
} from '@controllers/progressView/followUpApply';
import type { ProgressHostInteractions } from '@controllers/progressView/backend/progressHostInteractions';
import { ProgressWorkflowRunActionsController } from '@controllers/progressView/ProgressWorkflowRunActionsController';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import {
  createProgressAgentProposalController,
  type ProgressAgentProposalController,
} from '@controllers/progressView/ProgressAgentProposalController';
import {
  createProgressViewCommandHandlers,
  createProgressViewSecondTierHandlers,
  type ProgressViewSecondTierActions,
} from '@controllers/progressView/ProgressViewCommandHandlers';
import { ChatExportController } from '@controllers/progressView/ChatExportController';
import {
  TRANSCRIPT_EXPORT_FORMAT_CHOICES,
  type TranscriptExportFormat,
  type TranscriptExportOpenKind,
} from '@controllers/progressView/exportTranscript';
import { submitProgressFollowUp } from '@controllers/progressView/progressFollowUpSubmit';
import { SecretManager } from '@frontend/secretManager';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { RecordingManager } from '@frontend/media/RecordingManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import type { PromptHost } from '@hosts/uiHosts';
import { apiKeySecretName } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { getRuntimeModelDirectFallback } from '@model/runtimeModelRegistry';
import { platform } from '@platform/platform';
import latexPreamble from '@resources/templates/chatExport.tex';
import type {
  GettingStartedAction,
  ProgressViewInboundHandlerRegistry,
  ProgressViewInboundMessage,
  ProgressViewOutboundMessage,
  StreamTabId,
} from '@shared/schemas';
import {
  dispatchProgressViewInbound,
  GETTING_STARTED_COMMANDS,
} from '@shared/schemas';
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { ALL_STREAMS_DELETED_CAUSE } from '@shared/copy/interactionCancellation';
import { unsupportedCommands } from '@shared/utils/dispatcher';
import {
  cleanupUnscopedApprovals,
  releaseStreamResources,
} from '@tools/approval';
import {
  findTranscriptSpillFile,
  spillArtifactOpenFailedMessage,
  SPILL_ARTIFACT_DELETED_MESSAGE,
} from '@transcript';
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
  private readonly workflowFileActionsController: ProgressWorkflowFileActionsController;
  private readonly agentProposalController: ProgressAgentProposalController;
  private readonly commandHandlers: ReturnType<
    typeof createProgressViewCommandHandlers
  >;
  private readonly workflowRunActionsController: ProgressWorkflowRunActionsController;
  private readonly apiKeyRetryController: ProgressApiKeyRetryController;
  private readonly followUpController: ProgressFollowUpController;
  private readonly followUpPolishController: ProgressFollowUpPolishController;
  private chatExportController: ChatExportController | undefined;

  /**
   * Type-safe handler registry - handlers receive typed data.
   */
  private readonly handlerRegistry: ProgressViewInboundHandlerRegistry;

  /**
   * The one info-notification adapter the controller ports are wired to. The
   * host returns the chosen button, which no port consumer reads — discard it
   * so the port stays a plain notification.
   */
  private readonly showInfo = async (message: string): Promise<void> => {
    await this.host.info(message);
  };

  /** Same discard-the-answer shape as `showInfo`, reused by the port bindings below. */
  private readonly showWarning = async (message: string): Promise<void> => {
    await this.host.warning(message);
  };

  private readonly showError = async (message: string): Promise<void> => {
    await this.host.error(message);
  };

  /** This host's bindings for the shared follow-up plan/polish interpreters. */
  private readonly followUpPorts: FollowUpApplyPorts = {
    showInfo: this.showInfo,
    showWarning: this.showWarning,
    showError: this.showError,
    logError: (message, error) => {
      this.log.error(message, { data: error });
    },
    post: (message) => {
      this.postToActiveView(message);
    },
    runCompileFixer: (request) =>
      this.executeValidated(request, { preferHelperModel: true }),
  };

  /**
   * One adapter over the snapshot store for every progress-view port that
   * wants one. The store cannot be passed raw -- `preload` takes a list and
   * the workspace-only path read has a different name -- and each controller
   * asks for a different subset, so this is the superset. Passed by reference,
   * excess-property checking does not apply and each port's type still narrows
   * it to the members that port declares.
   */
  private readonly snapshotPort = {
    getActiveStream: () => this.provider.backend.presentation.activeStream,
    getRunMetadata: (stream: StreamTabId) =>
      this.provider.state.snapshots.getRunMetadata(stream),
    getOutputFiles: (stream: StreamTabId) =>
      this.provider.state.snapshots.getOutputFiles(stream),
    getCompileFailures: (stream: StreamTabId) =>
      this.provider.state.snapshots.getCompileFailures(stream),
    getKnownWorkspaceOutputPaths: (stream: StreamTabId) =>
      this.provider.state.snapshots.getKnownFilePaths(stream, {
        workspaceOnly: true,
      }),
    preload: (stream: StreamTabId) =>
      this.provider.state.snapshots.preload([stream]),
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

    this.workflowRunActionsController =
      this.createWorkflowRunActionsController();
    this.workflowFileActionsController =
      this.createWorkflowFileActionsController();
    this.agentProposalController = this.createAgentProposalController();
    this.commandHandlers = this.createSharedCommandHandlers();
    this.apiKeyRetryController = this.createApiKeyRetryController();
    this.followUpController = this.createFollowUpController();
    this.followUpPolishController = new ProgressFollowUpPolishController();
    this.handlerRegistry = this.createHandlerRegistry();
  }

  public cleanupDeletedStream(stream: StreamTabId): void {
    releaseStreamResources(stream);
    this.workflowFileActionsController.clearStreamBackups(stream);
  }

  public cleanupDeletedStreams(options: { allDeleted: boolean }): void {
    if (!options.allDeleted) return;
    cleanupUnscopedApprovals();
    this.interactions.cancel({ cause: ALL_STREAMS_DELETED_CAUSE });
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
      getRunMetadata: this.snapshotPort.getRunMetadata,
      preload: this.snapshotPort.preload,
      workflowRunActions: this.workflowRunActionsController,
      apiKeyRetry: this.apiKeyRetryController,
      followUp: this.followUpController,
      followUpPolish: this.followUpPolishController,
      host: { showInfo: this.showInfo },
      session: defaultSession(),
      restoreRunConfig: async (config) => {
        await this.runViewCommand('texra.restoreState', [config]);
      },
      applyFollowUpPlan: (plan) => applyFollowUpPlan(plan, this.followUpPorts),
      capturePolishReporter: () => {
        const post = this.captureResultPost('Follow-up polish result');
        const ports = { ...this.followUpPorts, post };
        return {
          applyResult: (result) => applyFollowUpPolishResult(result, ports),
          reportError: (stream, error) =>
            this.reportPolishError(stream, error, post),
        };
      },
      onPolishProgress: (message) => {
        polishProgress?.report({ message });
      },
      restoreProposalConfig: async (proposal) => {
        const restored =
          await this.agentProposalController.restoreProposalConfig(proposal);
        if (!restored) return;
        this.log.info('Restored proposal config to main view', {
          data: {
            agent: proposal.agent,
            agentCategory: proposal.agentCategory,
          },
        });
      },
      retry: {
        submit: (stream, requestId, feedback) =>
          this.interactions.submitRetryDecision(stream, requestId, {
            action: 'retry',
            feedback,
          }),
        cancel: (stream, requestId) =>
          this.interactions.submitRetryDecision(stream, requestId, {
            action: 'cancel',
          }),
      },
      transcriptExport: {
        pickFormat: () => this.pickTranscriptExportFormat(),
        openPath: (filePath, kind) => this.openExportPath(filePath, kind),
        showInfo: this.showInfo,
        showWarning: this.showWarning,
        showError: this.showError,
        reportDetail: (message, data) => {
          this.log.error(message, { data });
        },
        getController: () => Promise.resolve(this.getChatExportController()),
        getTraceViewerTemplate: () =>
          path.join(
            this.provider.extensionPath,
            'resources',
            'traceViewer',
            'index.html',
          ),
      },
    };

    const secondTierHandlers =
      createProgressViewSecondTierHandlers(secondTierActions);

    return {
      // Common handlers - passthrough to webview
      [PROGRESS_VIEW_COMMANDS.WEBVIEW_READY]: async () => {
        this.log.debug('Webview ready signal received');
        const view = this.getActiveView();
        if (view) {
          await this.provider.markWebviewReady(view);
        }
      },
      [COMMON_COMMANDS.SWITCH_VIEW]: (data) => this.switchView(data),
      [PROGRESS_VIEW_COMMANDS.POP_OUT]: () => this.provider.popOutToEditor(),
      [PROGRESS_VIEW_COMMANDS.POP_BACK]: () => this.provider.showInSidebar(),

      // First-tier shared progress command groups
      ...this.commandHandlers,

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
        const reporter = secondTierActions.capturePolishReporter();
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
                reporter,
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

  private createWorkflowFileActionsController(): ProgressWorkflowFileActionsController {
    return new ProgressWorkflowFileActionsController({
      state: this.snapshotPort,
      host: {
        compareFiles: (baseFile, editedFile) =>
          this.runViewCommand('texra.compare', [
            pathToLocation(baseFile),
            pathToLocation(editedFile),
          ]),
        acceptEditedFile: (baseFile, editedFile, copyMeta) =>
          this.runViewCommand<boolean>('texra.acceptEdited', [
            pathToLocation(baseFile),
            pathToLocation(editedFile),
            copyMeta,
          ]),
        mergeFile: (baseFile, editedFile) =>
          this.runViewCommand('texra.merge', [baseFile, editedFile]),
        latexdiffFile: (baseFile, editedFile) =>
          this.runViewCommand('texra.latexdiff', [
            undefined,
            baseFile,
            editedFile,
          ]),
        openDirectory: (directory) =>
          this.runViewCommand('revealFileInOS', [vscode.Uri.file(directory)]),
        openLabel: (label) =>
          this.runViewCommand<boolean>('texra.openLabel', [
            label,
            { notifyNotFound: false },
          ]).then((result) => result ?? false),
        readFile: (file) => AbsoluteFS.read(file),
        showInfo: this.showInfo,
        showError: this.showError,
        logError: (message, error) => {
          this.log.error(message, {
            data: error instanceof Error ? error : undefined,
          });
        },
      },
      // Programmatic send with no composer behind it (the workflow-file "user
      // modified the suggested output" note), so `acknowledge` is deliberately
      // a no-op — there is no draft to hand back. Bound inline, exactly as
      // desktop binds it in desktopAgentExecution.ts.
      sendFollowUp: async (stream, text) => {
        await submitProgressFollowUp({
          session: defaultSession(),
          streamId: stream,
          input: { text },
          acknowledge: () => {},
          // Warning, not info: the deleted `texra.sendFollowUp` command used
          // `showWarningMessage`, and a refused follow-up means the model never
          // received the accepted-file modification notice — easy to miss as an
          // informational toast.
          showInfo: this.showWarning,
        });
      },
    });
  }

  private createAgentProposalController(): ProgressAgentProposalController {
    return createProgressAgentProposalController({
      getPendingProposal: (requestId) =>
        this.provider.getPendingAgentProposal(requestId),
      restoreRunConfig: async (config) =>
        (await this.runViewCommand<boolean>('texra.restoreState', [config])) ===
        true,
      openFile: async (file) => {
        await this.runViewCommand('texra.openFile', [file]);
      },
      submitProposalDecision: (requestId, result) =>
        this.interactions.submitProposalDecision(requestId, result),
      log: this.log,
    });
  }

  private createSharedCommandHandlers(): ReturnType<
    typeof createProgressViewCommandHandlers
  > {
    return createProgressViewCommandHandlers({
      run: {
        state: this.snapshotPort,
        // Workflow actions intentionally wait for the run to finish.
        runExecutionRequest: (request) => this.executeValidated(request),
      },
      workflowFileActions: this.workflowFileActionsController,
      agentProposal: this.agentProposalController,
      lifecycle: {
        setActiveStream: (stream, requestId) =>
          this.provider.setActiveStream(stream, requestId),
        deleteStream: (stream) => this.provider.backend.deleteStream(stream),
        deleteAllStreams: () => this.handleDeleteAll(),
        stopStream: (stream) => this.provider.backend.stopStream(stream),
      },
      followUp: {
        captureAdmissionReporter: () => {
          const post = this.captureResultPost('Follow-up admission result');
          return (stream, accepted) => {
            post({
              command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_RESULT,
              stream,
              accepted,
            });
          };
        },
        reportImageSaveError: (_image, error) => {
          // Best-effort: a failed image save must not block the text, but log
          // it so a missing attachment is diagnosable.
          this.log.warn(
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
        openSpillArtifact: async (spillPath) => {
          try {
            await defaultSession().flushArtifacts();
            const file = await findTranscriptSpillFile(spillPath);
            if (!file) {
              await this.host.error(SPILL_ARTIFACT_DELETED_MESSAGE);
              return;
            }
            const document = await vscode.workspace.openTextDocument(
              vscode.Uri.file(file),
            );
            await vscode.window.showTextDocument(document, { preview: true });
          } catch (error) {
            await this.host.error(
              spillArtifactOpenFailedMessage(toErrorMessage(error)),
            );
          }
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
    });
  }

  private getChatExportController(): ChatExportController {
    this.chatExportController ??= new ChatExportController({ latexPreamble });
    return this.chatExportController;
  }

  private async pickTranscriptExportFormat(): Promise<
    TranscriptExportFormat | undefined
  > {
    // The shared choices are already quick-pick items: `label` and
    // `description` carry the presentation, `format` rides along as the answer.
    const picked = await vscode.window.showQuickPick(
      TRANSCRIPT_EXPORT_FORMAT_CHOICES,
      {
        title: 'Export transcript',
        placeHolder: 'Choose a format',
        ignoreFocusOut: true,
      },
    );
    return picked?.format;
  }

  private async openExportPath(
    filePath: string,
    kind: TranscriptExportOpenKind,
  ): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    if (kind === 'external') {
      await vscode.env.openExternal(uri);
      return;
    }
    if (kind === 'pdf') {
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private createWorkflowRunActionsController(): ProgressWorkflowRunActionsController {
    return new ProgressWorkflowRunActionsController({
      state: this.snapshotPort,
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
        await this.runViewCommand(EXTENSION_COMMANDS.SET_API_KEY, [provider]);
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
        const { modelOptions } = await loadOptions();
        return modelOptions;
      },
      state: this.snapshotPort,
      workspace: WorkspaceFS,
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

    await this.provider.state.snapshots.preload([data.stream]);
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
          stream: data.stream,
          requestId: data.requestId,
          provider: fallback.provider,
          model: fallback.model,
          exhaustionReason: data.exhaustionReason,
          chatGptSubscriptionEligible: fallback.chatGptSubscriptionEligible,
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

  /**
   * Capture a result route that never falls through to a replacement surface
   * or document. A missing, replaced, disposed, or rejecting target is undeliverable;
   * diagnose that at debug without turning completed work into a run failure.
   */
  private captureResultPost(
    resultName: string,
  ): (message: ProgressViewOutboundMessage) => void {
    const source = this.getActiveView()?.webview;
    const isSourceDocumentCurrent = source
      ? this.provider.captureWebviewDocument(source)
      : () => false;
    return (message) => {
      if (!source) {
        this.log.debug(`${resultName} is undeliverable: target is unavailable`);
        return;
      }
      void Promise.resolve()
        .then(() => {
          if (!isSourceDocumentCurrent()) {
            this.log.debug(
              `${resultName} is undeliverable: target document was replaced`,
            );
            return true;
          }
          return source.postMessage(message);
        })
        .then(
          (delivered) => {
            if (!delivered) {
              this.log.debug(
                `${resultName} is undeliverable: target did not accept the message`,
              );
            }
          },
          (error: unknown) => {
            this.log.debug(
              `${resultName} is undeliverable: target is no longer attached`,
              { data: error },
            );
          },
        );
    };
  }

  /** Post the polish failure to the renderer, surface it, and log it. */
  private reportPolishError(
    stream: StreamTabId,
    error: unknown,
    post: (message: ProgressViewOutboundMessage) => void,
  ): void {
    const errorMsg = toErrorMessage(error);
    post({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
      stream,
      kind: 'polishError',
      text: null,
      error: errorMsg,
    });
    void this.host.error(`Could not polish the follow-up: ${errorMsg}`);
    this.log.error(`Error polishing follow-up: ${errorMsg}`, {
      data: error instanceof Error ? error : undefined,
    });
  }

  private handlePlanApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION>,
  ): void {
    const { requestId, action } = data;
    this.interactions.submitPlanDecision(
      requestId,
      action === 'reject'
        ? { action: 'reject', feedback: data.feedback }
        : { action },
    );
  }

  // ============================================================
  // Helper methods
  // ============================================================

  /**
   * Validate an agent request and run it. No caller reports the rejection, so
   * this owns it: a request dropped here is a run the user asked for and would
   * otherwise never see start or fail.
   */
  private async executeValidated(
    request: ExecutionRequest,
    options: { preferHelperModel?: boolean } = {},
  ): Promise<void> {
    const validation = validateExecutionRequest(request);
    if (!validation.valid) {
      this.log.error(validation.message);
      await this.host.error(validation.message);
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
      this.log.error(validation.message);
      await this.host.error(validation.message);
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
}
