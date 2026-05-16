import * as vscode from 'vscode';

import { ProgressStreamLifecycleController } from '@controllers/progressView/ProgressStreamLifecycleController';
import {
  ProgressFollowUpController,
  type ProgressFollowUpPlan,
} from '@controllers/progressView/ProgressFollowUpController';
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { ProgressWorkflowActionsController } from '@controllers/progressView/ProgressWorkflowActionsController';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { getAgent } from '@agent/index';
import {
  cancelRetry,
  resolvePlanApproval,
  resolveProposal,
  triggerRetry,
} from '@agent/runtime/runCoordinators';
import {
  validateExecutionRequest,
  type ExecutionRequest,
} from '@agent/core/executionRequests';
import { getServerSideKeyService } from '@auth/serverKeys';
import { apiKeyCommands } from '@commands/api/apiKeyCommands';
import { toErrorMessage } from '@common/errors';
import {
  BaseViewMessageHandler,
  COMMON_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
} from '@common/webview';
import { RecordingManager } from '@common/managers/RecordingManager';
import { bus } from '@eventBus/ProgressEventBus';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { loadOptions } from '@frontend/agents/optionsLoader';
import { handleProgressViewToolEditApprovalAction } from '@frontend/approval/nativeToolEditApproval';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { StreamTabId } from '@shared/schemas';
import {
  dispatchProgressViewInbound,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { handleExternalInquiryAction } from '@tools/inquiry';
import { persistOpenTurnDraft } from '@tools/inquiry/externalInquiryStorage';
import { handleUserQuestionAction } from '@tools/userQuestion';
import {
  handleProgressViewBashApprovalAction,
  toggleToolEditApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
  isApprovalBypassedForStream,
  toggleProposalBypass,
} from '@tools/approval';
import {
  createExternalLocation,
  flexibleFS,
  pathToLocation,
  WorkspaceFS,
} from '@utils/files';
import {
  buildFileContextFromTaskState,
  polishTextWithAI,
} from '@utils/text/textEnhancementUtils';

import { OdysseyStore, isOdysseyInFlight } from '@tools/odyssey';
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
  private readonly followUpController: ProgressFollowUpController;
  private readonly modelOutputBackups = new Map<
    StreamTabId,
    Map<string, { content: string; streamId: StreamTabId }>
  >();

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

    this.handlerRegistry = this.createHandlerRegistry();
    this.streamLifecycleController = this.createStreamLifecycleController();
    this.workflowActionsController = this.createWorkflowActionsController();
    this.workflowFileActionsController =
      this.createWorkflowFileActionsController();
    this.agentProposalController = this.createAgentProposalController();
    this.followUpController = this.createFollowUpController();

    const unsubscribeRemoveStream = bus.on('removeStream', ({ streamId }) => {
      void this.handleDeleteStream({
        command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        stream: streamId,
      });
      void OdysseyStore.forget(streamId);
    });
    context.subscriptions.push({ dispose: unsubscribeRemoveStream });

    const unsubscribeOdyssey = bus.on('odysseyStateChanged', ({ streamId }) => {
      const odyssey = OdysseyStore.getForStream(streamId);
      this.provider.webviewUpdater.updateOdysseyActive(
        streamId,
        isOdysseyInFlight(odyssey),
        { status: odyssey?.status, objective: odyssey?.objective },
      );
    });
    context.subscriptions.push({ dispose: unsubscribeOdyssey });
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

      // Stream management
      [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (data) =>
        this.provider.setActiveStream(data.stream),
      [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data) =>
        this.handleDeleteStream(data),
      [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => this.handleDeleteAll(),
      [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (data) =>
        this.streamLifecycleController.stopStream(data.stream),
      [PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE]: async (data) =>
        vscode.commands.executeCommand('texra.compactResponse', data.stream),

      // Actions
      [PROGRESS_VIEW_COMMANDS.RESUME]: (data) =>
        this.workflowActionsController.resume(data.stream),
      [PROGRESS_VIEW_COMMANDS.RUN_NEW]: (data) =>
        this.workflowActionsController.runNew(data.stream),
      [PROGRESS_VIEW_COMMANDS.DIFF_STREAM]: (data) =>
        this.workflowActionsController.diffStream(data.stream),
      [PROGRESS_VIEW_COMMANDS.PACK_STREAM]: (data) =>
        this.workflowActionsController.runFileOperation(data.stream, 'pack'),
      [PROGRESS_VIEW_COMMANDS.CLEAN_STREAM]: (data) =>
        this.workflowActionsController.runFileOperation(data.stream, 'clean'),
      [PROGRESS_VIEW_COMMANDS.FILTER_STREAMS]: (data) => {
        this.provider.state.agentCategoryFilter = data.filter;
        this.provider.syncFullView();
      },
      [PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST]: (data) =>
        this.handleRetryStreamRequest(data),
      [PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST]: (data) => {
        cancelRetry(data.stream);
      },
      [PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY]: (data) =>
        this.handleUseOwnApiKey(data),
      [PROGRESS_VIEW_COMMANDS.RESTORE_STATE]: async (data) => {
        const taskState = this.provider.state.meta.getTaskState(data.stream);
        if (taskState) {
          await vscode.commands.executeCommand('texra.restoreState', taskState);
        }
      },
      [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]: async (data) => {
        await vscode.commands.executeCommand('texra.sendFollowUp', {
          stream: data.stream,
          text: data.text,
        });
      },
      [PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE]: (data) =>
        this.workflowFileActionsController.openTaskStorage(data.stream),
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
      [PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION]: (data) =>
        handleProgressViewToolEditApprovalAction(data),
      [PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS]: async (
        data,
      ) => {
        const isNowEnabled = toggleToolEditApprovalSessionBypass(
          data.stream,
          extensionAgentRuntimeHost,
        );
        const msg = isNowEnabled
          ? 'YOLO mode enabled: Tool actions will be auto-approved for this stream.'
          : 'YOLO mode disabled: Tool actions will prompt for approval.';
        await vscode.window.showInformationMessage(msg);
      },
      [PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS]: async (data) => {
        const isNowEnabled = toggleProposalBypass(
          data.stream,
          extensionAgentRuntimeHost,
        );
        if (isNowEnabled) {
          // Delegation auto-approval also accepts tool edits in this stream.
          if (!isApprovalBypassedForStream(data.stream)) {
            setToolEditApprovalSessionBypass(
              data.stream,
              true,
              extensionAgentRuntimeHost,
            );
          }
        } else {
          // Returning to manual task approval also restores edit prompts.
          setToolEditApprovalSessionBypass(
            data.stream,
            false,
            extensionAgentRuntimeHost,
          );
        }
        const msg = isNowEnabled
          ? 'Delegated task auto-approval enabled for this stream.'
          : 'Delegated task auto-approval disabled for this stream.';
        await vscode.window.showInformationMessage(msg);
      },
      [PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]: async (data) => {
        await this.agentProposalController.handleAction(data);
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
      [PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION]: (data) =>
        handleProgressViewBashApprovalAction(data),
      [PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION]: (data) =>
        this.handlePlanApprovalAction(data),
      [PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION]: async (data) => {
        if (data.action === 'draft') {
          await persistOpenTurnDraft({
            threadId: data.threadId,
            draft: data.draft ?? null,
          });
          return;
        }
        if (data.action === 'submit' && data.answer) {
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
      [PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION]: (data) =>
        handleUserQuestionAction(data),

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

      // File operations
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: async (data) =>
        vscode.commands.executeCommand('texra.openFile', data.file, data.line),
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: async (data) =>
        vscode.commands.executeCommand('texra.openFileCompile', data.file),
      [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: (data) =>
        this.workflowFileActionsController.compareOriginal(
          data.file,
          data.base,
        ),
      [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: (data) =>
        this.workflowFileActionsController.comparePrevious(
          data.file,
          data.base,
          data.prev,
        ),
      [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: (data) =>
        this.workflowFileActionsController.acceptFile(data.file, data.base),
      [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: (data) =>
        this.workflowFileActionsController.mergeFile(data.file, data.base),
      [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: (data) =>
        this.workflowFileActionsController.latexdiffFile(data.file, data.base),
      [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: async (data) =>
        this.workflowFileActionsController.openLabel(data.label),
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
    await this.withActiveView(webviewView, async () => {
      const handled = dispatchProgressViewInbound(
        message,
        this.handlerRegistry,
        (error) => {
          this.logger.debug(this.channel, 'Message validation failed', {
            data: error,
          });
        },
      );

      if (
        !handled &&
        message &&
        typeof message === 'object' &&
        'command' in message
      ) {
        this.logger.warn(
          this.channel,
          `Unhandled command: ${(message as { command: string }).command}`,
        );
      }
    });
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

  private postToActiveView(message: unknown): void {
    this.getActiveView()?.webview.postMessage(message);
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
          Boolean(this.provider.state.meta.getTaskState(stream)),
        getStreamIds: () => this.provider.state.streamLogs.keys(),
        pickValidActiveStream: (streams) =>
          this.provider.state.pickValidActiveStream(streams),
        clearStream: (stream) => this.provider.state.clearStream(stream),
        clearAll: () => this.provider.state.clearAll(),
      },
      host: new ProgressStreamLifecycleHost(
        this.provider,
        this.modelOutputBackups,
      ),
    });
  }

  private createWorkflowActionsController(): ProgressWorkflowActionsController {
    return new ProgressWorkflowActionsController({
      state: {
        getTaskState: (stream) => this.provider.state.meta.getTaskState(stream),
        getExecutionId: (stream) =>
          this.provider.state.meta.getExecutionId(stream),
        getOutputFiles: (stream) =>
          this.provider.state.outputFiles.getFiles(stream),
        getKnownWorkspaceOutputPaths: (stream) =>
          this.provider.state.outputFiles.getKnownFilePaths(stream, {
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
          this.provider.state.meta.getExecutionId(stream),
        getOutputFiles: (stream) =>
          this.provider.state.outputFiles.getFiles(stream),
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
        acceptEditedFile: async (baseFile, editedFile) => {
          await vscode.commands.executeCommand(
            'texra.acceptEdited',
            pathToLocation(''), // inputFile unused
            pathToLocation(baseFile),
            pathToLocation(editedFile),
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
      modelOutputBackups: this.modelOutputBackups,
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
        resolveProposal(proposalId, result);
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

  private createFollowUpController(): ProgressFollowUpController {
    return new ProgressFollowUpController({
      getAgentCategory: (agent) => getAgent(agent, true)?.category,
      workspace: {
        locatePath: (candidate) => WorkspaceFS.locatePath(candidate),
        exists: (relativePath) => WorkspaceFS.exists(relativePath),
      },
    });
  }

  // ============================================================
  // Stream management handlers
  // ============================================================

  private async handleDeleteStream(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.DELETE_STREAM>,
  ): Promise<void> {
    await this.streamLifecycleController.deleteStream(data.stream);
  }

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
    const success = triggerRetry(data.stream, data.feedback);
    if (!success) {
      await vscode.window.showInformationMessage(
        'No retryable request is available for this stream yet.',
      );
    }
  }

  private async handleUseOwnApiKey(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY>,
  ): Promise<void> {
    const providerArg = (
      SecretManager.API_PROVIDERS as readonly string[]
    ).includes(data.provider ?? '')
      ? (data.provider as ApiProvider)
      : undefined;

    // The gate depends on WHICH credential is exhausted:
    //   - Upstream credit depletion (Anthropic 400 "credit balance is
    //     too low"): the STORED key is the broken one, so we require
    //     evidence of a key change.
    //   - Relay monthly limit (or unknown provider): the stored key is
    //     fine, so any usable key counts as consent.
    // `anyApiKeyExists()` is deliberately NOT used — it also returns
    // true when only relay access is available.
    const providersToCheck = providerArg
      ? [providerArg]
      : SecretManager.API_PROVIDERS;
    const readKey = (p: ApiProvider) =>
      SecretManager.get(SecretManager.getApiKeySecretName(p));

    const requireChange = data.upstreamCreditDepleted === true;
    const before = requireChange
      ? new Map(
          await Promise.all(
            providersToCheck.map(async (p) => [p, await readKey(p)] as const),
          ),
        )
      : undefined;

    await vscode.commands.executeCommand(apiKeyCommands.setApiKey, providerArg);

    let shouldProceed: boolean;
    if (requireChange) {
      const after = new Map(
        await Promise.all(
          providersToCheck.map(async (p) => [p, await readKey(p)] as const),
        ),
      );
      shouldProceed = providersToCheck.some((p) => {
        const next = after.get(p);
        return (
          typeof next === 'string' &&
          next.trim().length > 0 &&
          next !== before!.get(p)
        );
      });
    } else {
      const usable = await Promise.all(
        providersToCheck.map((p) => SecretManager.hasUsableApiKey(p)),
      );
      shouldProceed = usable.some(Boolean);
    }

    if (!shouldProceed) {
      return;
    }

    // Only disable relay access when the failing call actually went
    // through relay. If the error came from a direct-key call (e.g.
    // user's own Anthropic key ran out of credit on a tier that
    // routes Anthropic directly while other providers still go via
    // relay), flipping the global mode would revoke relay for the
    // other providers too.
    if (data.viaRelay === true) {
      await getServerSideKeyService().setUseIncludedModelAccess(false);
      invalidateModelOptionsCache();
    }
    const retried = triggerRetry(data.stream);
    if (!retried) {
      await vscode.window.showInformationMessage(
        'Switched to your own API key. No pending retry to resume — run the agent again when ready.',
      );
    }
  }

  private async handlePolishFollowUp(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP>,
  ): Promise<void> {
    const taskState = this.provider.state.meta.getTaskState(data.stream);
    if (!taskState) return;

    const fileContext = buildFileContextFromTaskState(taskState);

    const sendPolishError = (errorMsg: string): void => {
      this.postToActiveView({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
        stream: data.stream,
        kind: 'polishError',
        text: null,
        error: errorMsg,
      });
    };

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
          const result = await polishTextWithAI(data.text, fileContext);
          progress.report({
            message: 'Applying changes...',
            increment: 60,
          });

          if (result.success) {
            this.postToActiveView({
              command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
              stream: data.stream,
              kind: 'polished',
              text: result.text,
            });
          } else if (result.error) {
            sendPolishError(result.error);
            await vscode.window.showErrorMessage(result.error);
          }
        } catch (error) {
          const errorMsg = toErrorMessage(error);
          sendPolishError(errorMsg);
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

  private handlePlanApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION>,
  ): void {
    const { approvalId, action } = data;
    switch (action) {
      case 'approve':
        resolvePlanApproval(approvalId, {
          action: 'approve',
        });
        break;
      case 'reject':
        resolvePlanApproval(approvalId, {
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
    const taskState = this.provider.state.meta.getTaskState(data.stream);
    const outputFiles = [
      ...this.provider.state.outputFiles.getFiles(data.stream).values(),
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
        executionId: this.provider.state.meta.getExecutionId(data.stream),
      }),
    );
  }

  private async handleRunCompileFixer(streamId: StreamTabId): Promise<void> {
    const taskState = this.provider.state.meta.getTaskState(streamId);
    const compileFailures = [
      ...this.provider.state.outputFiles.getCompileFailures(streamId).values(),
    ].flat();
    const { modelOptions } = await loadOptions();

    await this.applyFollowUpPlan(
      await this.followUpController.planCompileFixer({
        streamId,
        taskState,
        compileFailures,
        runOutputs: this.provider.state.outputFiles.getFiles(streamId),
        modelOptions,
        executionId: this.provider.state.meta.getExecutionId(streamId),
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
