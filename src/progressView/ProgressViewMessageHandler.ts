import * as path from 'path';
import * as vscode from 'vscode';

import {
  dispatchProgressViewInbound,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressViewInboundMessages';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { getAgent, computeAgentOptionsData } from '@agent/index/agentRegistry';
import { proposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { toErrorMessage } from '@common/errors';
import {
  BaseViewMessageHandler,
  PROGRESS_VIEW_COMMANDS,
} from '@common/webview';
import { RecordingManager } from '@common/managers/RecordingManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  isWorkflowTaskState,
  type TaskState,
  type WorkflowTaskState,
} from '@logger/TaskState';
import { computeModelOptionsData } from '@model/computeModelOptions';
import {
  CHAT_INSTRUCTION_TEMPLATE,
  WORKFLOW_CONTEXT_TEMPLATE,
  type FollowupInstructionVars,
} from '@progressView/templates/followupInstructionTemplates';
import {
  cleanupAllApprovals,
  cleanupApprovalsForStream,
  handleProgressViewBashApprovalAction,
  handleProgressViewToolEditApprovalAction,
  toggleToolEditApprovalSessionBypass,
} from '@tools/approval';
import { getConfig } from '@utils/config';
import { isNonEmptyString } from '@utils/core';
import {
  createExternalLocation,
  createFileMapping,
  flexibleFS,
  pathToLocation,
  WorkspaceFS,
} from '@utils/files';
import { ensureRunDir, getRunDir } from '@utils/files/taskRunStorage';
import { renderPrompt } from '@utils/prompt/promptUtils';
import {
  buildFileContextFromTaskState,
  polishTextWithAI,
} from '@utils/text/textEnhancementUtils';
import type { OutputFileInfo, StorageKey, StreamTabId } from '@shared/schemas';

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
  private readonly modelOutputBackups = new Map<
    string,
    { content: string; streamId: StreamTabId }
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
      recordingStartedCommand: PROGRESS_VIEW_COMMANDS.RECORDING_STARTED,
      recordingStoppedCommand: PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED,
      recordingErrorCommand: PROGRESS_VIEW_COMMANDS.RECORDING_ERROR,
      transcriptionCommand: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED,
      progressTitle: 'Transcribing follow-up message',
    });

    this.handlerRegistry = this.createHandlerRegistry();
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

      // Stream management
      [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (data) =>
        this.handleSwitchStream(data),
      [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data) =>
        this.handleDeleteStream(data),
      [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => this.handleDeleteAll(),
      [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (data) =>
        this.handleStopStream(data),

      // Actions
      [PROGRESS_VIEW_COMMANDS.RESUME]: (data) => this.handleResume(data),
      [PROGRESS_VIEW_COMMANDS.RUN_NEW]: (data) => this.handleRunNew(data),
      [PROGRESS_VIEW_COMMANDS.DIFF_STREAM]: (data) =>
        this.handleDiffStream(data),
      [PROGRESS_VIEW_COMMANDS.PACK_STREAM]: (data) =>
        this.handlePackStream(data),
      [PROGRESS_VIEW_COMMANDS.CLEAN_STREAM]: (data) =>
        this.handleCleanStream(data),
      [PROGRESS_VIEW_COMMANDS.SORT_STREAMS]: (data) =>
        this.handleSortStreams(data),
      [PROGRESS_VIEW_COMMANDS.FILTER_STREAMS]: (data) =>
        this.handleFilterStreams(data),
      [PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST]: (data) =>
        this.handleRetryStreamRequest(data),
      [PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST]: (data) =>
        this.handleCancelRetryRequest(data),
      [PROGRESS_VIEW_COMMANDS.RESTORE_STATE]: (data) =>
        this.handleRestoreState(data),
      [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]: (data) =>
        this.handleSendFollowUp(data),
      [PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE]: (data) =>
        this.handleOpenTaskStorage(data),
      [PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP]: (data) =>
        this.handlePolishFollowUp(data),
      [PROGRESS_VIEW_COMMANDS.START_RECORDING]: () =>
        this.handleStartRecording(),
      [PROGRESS_VIEW_COMMANDS.STOP_RECORDING]: () => this.handleStopRecording(),
      [PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: (data) =>
        this.handleShowInformationMessage(data),
      [PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION]: (data) =>
        this.handleToolEditApprovalAction(data),
      [PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS]: (data) =>
        this.handleToggleToolEditApprovalBypass(data),
      [PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]: (data) =>
        this.handleAgentProposalAction(data),
      [PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION]: (data) =>
        this.handleBashApprovalAction(data),

      // Profile
      [PROGRESS_VIEW_COMMANDS.OPEN_PROFILE]: () => this.handleOpenProfile(),

      // Memory
      [PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW]: () =>
        this.handleOpenMemoryView(),

      // Followup task
      [PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS]: () =>
        this.handleGetFollowupOptions(),
      [PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP]: (data) =>
        this.handleSetupFollowup(data),
      [PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP]: (data) =>
        this.handleRunFollowup(data),

      // File operations
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: (data) => this.handleOpenFile(data),
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: (data) =>
        this.handleOpenFileCompile(data),
      [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: (data) =>
        this.handleCompareOriginal(data),
      [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: (data) =>
        this.handleComparePrevious(data),
      [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: (data) =>
        this.handleAcceptFile(data),
      [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: (data) => this.handleMergeFile(data),
      [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: (data) =>
        this.handleLatexdiffFile(data),
      [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: (data) => this.handleOpenLabel(data),
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
    // Track active view for handlers that need webview access
    this.setActiveView(webviewView);

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

  // ============================================================
  // Stream management handlers
  // ============================================================

  private handleSwitchStream(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.SWITCH_STREAM>,
  ): void {
    this.provider.setActiveStream(data.stream);
  }

  private async handleDeleteStream(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.DELETE_STREAM>,
  ): Promise<void> {
    const streamId = data.stream;
    const hasStream =
      this.provider.state.streamTabs.has(streamId) ||
      Boolean(this.provider.state.getTaskState(streamId));

    if (!hasStream) {
      return;
    }

    // Clear pending task groups, approvals, and YOLO state to prevent memory leaks
    this.provider.eventHandler.clearPendingTaskGroups(streamId);
    cleanupApprovalsForStream(streamId);
    await this.provider.state.clearStream(streamId);
    // Force rebuild since we deleted a stream
    this.provider.updateWebview({ forceRebuild: true });
  }

  private async handleDeleteAll(): Promise<void> {
    // Show confirmation dialog
    const confirmation = await vscode.window.showWarningMessage(
      'Are you sure you want to delete all streams? This action cannot be undone.',
      { modal: true },
      'Delete All',
      'Cancel',
    );

    if (confirmation !== 'Delete All') {
      return;
    }

    // Clear all pending task groups, approvals, and YOLO state to prevent memory leaks
    this.provider.eventHandler.clearAllPendingTaskGroups();
    cleanupAllApprovals();
    await this.provider.state.clearAll();
    // Force rebuild since we deleted all streams
    this.provider.updateWebview({ forceRebuild: true });
  }

  private async handleStopStream(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.STOP_STREAM>,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.stopAgent', data.stream);
  }

  // ============================================================
  // Action handlers
  // ============================================================

  private async handleResume(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.RESUME>,
  ): Promise<void> {
    const streamId = data.stream;
    const taskState = this.provider.state.getTaskState(streamId);
    if (!taskState) {
      return;
    }

    if (isWorkflowTaskState(taskState)) {
      const executionId = this.provider.state.getExecutionId(streamId);
      if (executionId) {
        await safeExecuteCommand('texra.execute', [
          { config: taskState.agentConfig, executionId },
        ]);
        return;
      }
    }

    await safeExecuteCommand('texra.execute', [taskState.agentConfig]);
  }

  private async handleRunNew(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.RUN_NEW>,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(data.stream);
    if (!taskState) {
      return;
    }
    await safeExecuteCommand('texra.execute', [taskState.agentConfig]);
  }

  private async handleRetryStreamRequest(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST>,
  ): Promise<void> {
    const success = retryCoordinator.triggerRetry(data.stream, data.feedback);
    if (!success) {
      await vscode.window.showInformationMessage(
        'No retryable request is available for this stream yet.',
      );
    }
  }

  private handleCancelRetryRequest(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST>,
  ): void {
    retryCoordinator.cancelRetry(data.stream);
  }

  private async handleDiffStream(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.DIFF_STREAM>,
  ): Promise<void> {
    const streamId = data.stream;
    await this.withToolbarTaskState(streamId, async (taskState) => {
      const executionId = this.provider.state.getExecutionId(streamId);
      const activeRunId = this.provider.state.getActiveRunId(streamId);
      const storageKey = (activeRunId ??
        executionId ??
        null) as StorageKey | null;
      const runOutputs = storageKey
        ? this.provider.state.getRunOutputFiles(streamId, { storageKey })
        : undefined;
      const outputsByRound = runOutputs
        ? Object.fromEntries(runOutputs.entries())
        : undefined;

      await vscode.commands.executeCommand('texra.runLatexdiff', {
        agent: taskState.agentConfig.agent,
        model: taskState.agentConfig.model,
        inputFile: taskState.agentConfig.inputFile,
        outputFiles: taskState.agentConfig.outputFiles,
        outputFilesActive: taskState.activeFiles.output,
        streamId,
        runId: executionId,
        outputsByRound,
      });
    });
  }

  private async handlePackStream(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.PACK_STREAM>,
  ): Promise<void> {
    await this.withToolbarTaskState(data.stream, async (taskState) => {
      await this.handleFileOperation(data.stream, taskState, 'texra.pack');
    });
  }

  private async handleCleanStream(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.CLEAN_STREAM>,
  ): Promise<void> {
    await this.withToolbarTaskState(data.stream, async (taskState) => {
      await this.handleFileOperation(data.stream, taskState, 'texra.clean');
    });
  }

  private handleSortStreams(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.SORT_STREAMS>,
  ): void {
    this.provider.state.streamSortOrder = data.sortBy;
    this.provider.updateWebview();
  }

  private handleFilterStreams(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.FILTER_STREAMS>,
  ): void {
    this.provider.state.agentCategoryFilter = data.filter;
    this.provider.updateWebview();
  }

  private async handleRestoreState(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.RESTORE_STATE>,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(data.stream);
    if (taskState) {
      await vscode.commands.executeCommand('texra.restoreState', taskState);
    }
  }

  private async handleSendFollowUp(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP>,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.sendFollowUp', {
      stream: data.stream,
      text: data.text,
    });
  }

  private async handlePolishFollowUp(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP>,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(data.stream);
    if (!taskState) return;

    const fileContext = buildFileContextFromTaskState(taskState);

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
            const view = this.getActiveView();
            view?.webview.postMessage({
              command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED,
              text: result.text,
            });
          } else if (result.error) {
            await vscode.window.showErrorMessage(result.error);
          }
        } catch (error) {
          const messageText = toErrorMessage(error);
          await vscode.window.showErrorMessage(
            `Error polishing follow-up: ${messageText}`,
          );
          this.logger.error(
            this.channel,
            `Error polishing follow-up: ${messageText}`,
            {
              data: error instanceof Error ? error : undefined,
            },
          );
        }
      },
    );
  }

  private async handleStartRecording(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.recordingManager.start(view);
    }
  }

  private async handleStopRecording(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.recordingManager.stop(view);
    }
  }

  private async handleShowInformationMessage(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE>,
  ): Promise<void> {
    await vscode.window.showInformationMessage(data.text);
  }

  private async handleToolEditApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION>,
  ): Promise<void> {
    await handleProgressViewToolEditApprovalAction(data);
  }

  private async handleToggleToolEditApprovalBypass(
    data: MessageFor<
      typeof PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS
    >,
  ): Promise<void> {
    const isNowEnabled = toggleToolEditApprovalSessionBypass(data.stream);
    const infoMessage = isNowEnabled
      ? 'YOLO mode enabled: Tool actions will be auto-approved for this stream.'
      : 'YOLO mode disabled: Tool actions will prompt for approval.';
    await vscode.window.showInformationMessage(infoMessage);
  }

  private async handleBashApprovalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION>,
  ): Promise<void> {
    await handleProgressViewBashApprovalAction(data);
  }

  private async handleAgentProposalAction(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION>,
  ): Promise<void> {
    const { proposalId, action, feedback } = data;
    switch (action) {
      case 'approve':
        proposalCoordinator.resolveRequest(proposalId, {
          action: 'approve',
        });
        break;
      case 'reject':
        proposalCoordinator.resolveRequest(proposalId, {
          action: 'reject',
          feedback,
        });
        break;
      case 'setup':
        await this.handleAgentProposalSetup(proposalId);
        break;
    }
  }

  private async handleAgentProposalSetup(proposalId: string): Promise<void> {
    const proposal = this.provider.getPendingAgentProposal(proposalId);
    if (!proposal) {
      this.logger.warn(
        this.channel,
        `No pending agent proposal found for setup: ${proposalId}`,
      );
      return;
    }

    const agentCategory =
      proposal.agentCategory === 'toolUse'
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;

    const isWorkflow = proposal.agentCategory === 'workflow';
    const hasFiles = (arr?: string[]): boolean => (arr?.length ?? 0) > 0;

    const activeFiles = {
      input: isWorkflow && hasFiles(proposal.inputFiles),
      reference: isWorkflow && hasFiles(proposal.referenceFiles),
      auxiliary: isWorkflow && hasFiles(proposal.auxiliaryFiles),
      media: isWorkflow && hasFiles(proposal.mediaFiles),
      output: isWorkflow && hasFiles(proposal.outputFiles),
    };

    const agentConfig = AgentConfigSchema.parse({
      agent: proposal.agent,
      model: proposal.model,
      instruction: proposal.instruction,
      agentCategory,
      ...(isWorkflow && {
        inputFile: proposal.inputFile,
        inputFiles: proposal.inputFiles,
        referenceFile: proposal.referenceFile,
        referenceFiles: proposal.referenceFiles,
        auxiliaryFile: proposal.auxiliaryFile,
        auxiliaryFiles: proposal.auxiliaryFiles,
        mediaFile: proposal.mediaFile,
        mediaFiles: proposal.mediaFiles,
        outputFiles: proposal.outputFiles,
        useMultipleOutputs: proposal.useMultipleOutputs,
        inputFilesActive: activeFiles.input,
        referenceFilesActive: activeFiles.reference,
        auxiliaryFilesActive: activeFiles.auxiliary,
        mediaFilesActive: activeFiles.media,
        outputFilesActive: activeFiles.output,
      }),
    });

    const taskState = (
      isWorkflow ? { agentConfig, activeFiles } : { agentConfig }
    ) as TaskState;

    proposalCoordinator.resolveRequest(proposalId, { action: 'setup' });

    await vscode.commands.executeCommand('texra.mainView.focus');
    await vscode.commands.executeCommand('texra.restoreState', taskState);

    this.logger.info(
      this.channel,
      `Agent proposal ${proposalId} set up in main view`,
      {
        data: { agent: proposal.agent },
      },
    );
  }

  private async handleOpenTaskStorage(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE>,
  ): Promise<void> {
    const streamId = data.stream;
    const storageKey = this.provider.state.getActiveRunId(streamId);
    const runOutputs = storageKey
      ? this.provider.state.getRunOutputFiles(streamId, { storageKey })
      : undefined;

    const executionId = this.provider.state.getExecutionId(streamId);

    try {
      let directoryToReveal: string | undefined;

      if (executionId) {
        await ensureRunDir(executionId);
        directoryToReveal = getRunDir(executionId);
      } else if (runOutputs) {
        directoryToReveal = this.findOutputDirectory(runOutputs);
      }

      if (!directoryToReveal) {
        await vscode.window.showInformationMessage(
          'No workspace storage folder is available for this run yet.',
        );
        return;
      }

      await safeExecuteCommand('revealFileInOS', [
        vscode.Uri.file(directoryToReveal),
      ]);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.logger.error(
        this.channel,
        `Failed to open task storage for stream ${streamId}, executionId ${executionId ?? 'unknown'}: ${errorMessage}`,
        {
          data: {
            error: error instanceof Error ? error : undefined,
            stream: streamId,
            executionId,
          },
        },
      );
      await vscode.window.showErrorMessage(
        'Unable to open the workspace storage folder for this run.',
      );
    }
  }

  // ============================================================
  // Navigation handlers
  // ============================================================

  private async handleOpenProfile(): Promise<void> {
    await vscode.commands.executeCommand('texra.auth.viewProfile');
  }

  private async handleOpenMemoryView(): Promise<void> {
    await vscode.commands.executeCommand('texra.showMemory');
  }

  // ============================================================
  // File operation handlers
  // ============================================================

  private async handleOpenFile(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.OPEN_FILE>,
  ): Promise<void> {
    await vscode.commands.executeCommand(
      'texra.openFile',
      data.file,
      data.line,
    );
  }

  private async handleOpenFileCompile(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE>,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openFileCompile', data.file);
  }

  private async handleCompareOriginal(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL>,
  ): Promise<void> {
    const { file, base } = data;
    const streamId = this.provider.state.activeStream;
    if (streamId && file) {
      try {
        const fileLocation = createExternalLocation(file);
        const content = await flexibleFS.read(fileLocation);
        this.modelOutputBackups.set(file, { content, streamId });
      } catch {
        // Ignore backup errors
      }
    }

    await this.executeWithBaseFile(
      file,
      base,
      'Compare original',
      (targetFile, baseFile) =>
        vscode.commands.executeCommand(
          'texra.compare',
          pathToLocation(''), // inputFile unused
          pathToLocation(baseFile),
          pathToLocation(targetFile),
        ),
    );
  }

  private async handleComparePrevious(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS>,
  ): Promise<void> {
    const { file, base, prev } = data;
    const previousFile = prev ?? base;

    if (previousFile) {
      await vscode.commands.executeCommand(
        'texra.latexdiff',
        undefined,
        previousFile,
        file,
      );
    }

    await vscode.commands.executeCommand(
      'texra.compare',
      pathToLocation(''), // inputFile unused
      pathToLocation(previousFile || ''),
      pathToLocation(file),
    );
  }

  private async handleAcceptFile(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.ACCEPT_FILE>,
  ): Promise<void> {
    const { file, base } = data;
    const backup = file ? this.modelOutputBackups.get(file) : null;
    let currentContent: string | null = null;

    if (backup) {
      try {
        const fileLocation = createExternalLocation(file);
        currentContent = await flexibleFS.read(fileLocation);
      } catch {
        // Ignore errors
      }
    }

    await this.executeWithBaseFile(
      file,
      base,
      'Accept',
      (targetFile, baseFile) =>
        vscode.commands.executeCommand(
          'texra.acceptEdited',
          pathToLocation(''), // inputFile unused
          pathToLocation(baseFile),
          pathToLocation(targetFile),
        ),
    );

    // Inform the model about user modifications via follow-up
    if (
      backup &&
      currentContent !== null &&
      currentContent !== backup.content
    ) {
      const fileName = path.basename(file);
      const followUpText = `[System: User modified the model's suggested output for "${fileName}" before accepting. The accepted version differs from the original model output.]`;

      await vscode.commands.executeCommand('texra.sendFollowUp', {
        stream: backup.streamId,
        text: followUpText,
      });
    }

    if (file) {
      this.modelOutputBackups.delete(file);
    }
  }

  private async handleMergeFile(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.MERGE_FILE>,
  ): Promise<void> {
    await this.executeWithBaseFile(
      data.file,
      data.base,
      'Merge',
      (targetFile, baseFile) =>
        vscode.commands.executeCommand(
          'texra.merge',
          undefined,
          baseFile,
          targetFile,
        ),
    );
  }

  private async handleLatexdiffFile(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE>,
  ): Promise<void> {
    await this.executeWithBaseFile(
      data.file,
      data.base,
      'Latexdiff',
      (targetFile, baseFile) =>
        vscode.commands.executeCommand(
          'texra.latexdiff',
          undefined,
          baseFile,
          targetFile,
        ),
    );
  }

  private async handleOpenLabel(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.OPEN_LABEL>,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openLabel', data.label);
  }

  // ============================================================
  // Followup task handlers
  // ============================================================

  private async handleGetFollowupOptions(): Promise<void> {
    const view = this.getActiveView();
    if (!view) return;

    try {
      const [agentOptionsData, modelOptionsData] = await Promise.all([
        computeAgentOptionsData(),
        computeModelOptionsData(),
      ]);

      const defaultMergeModel = getConfig<string>(
        'texra.merge.defaultModel',
        'gemini3f',
      );

      view.webview.postMessage({
        command: PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS,
        workflowAgentsData: agentOptionsData.workflow,
        toolUseAgentsData: agentOptionsData.toolUse,
        modelOptionsData,
        defaultMergeModel,
      });
    } catch (error) {
      this.logger.error(
        this.channel,
        `Failed to get followup options: ${toErrorMessage(error)}`,
      );
    }
  }

  private async handleSetupFollowup(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP>,
  ): Promise<void> {
    await this.processFollowup(data, false);
  }

  private async handleRunFollowup(
    data: MessageFor<typeof PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP>,
  ): Promise<void> {
    await this.processFollowup(data, true);
  }

  // ============================================================
  // Helper methods
  // ============================================================

  private async handleFileOperation(
    streamId: StreamTabId,
    taskState: WorkflowTaskState,
    command: 'texra.pack' | 'texra.clean',
  ): Promise<void> {
    const storageKey = this.provider.state.getActiveRunId(streamId);
    const generatedPaths = this.provider.state.outputFiles.getKnownFilePaths(
      streamId,
      { storageKey, workspaceOnly: true },
    );

    // Collect all output files from declared config and generated paths
    const declaredOutputs = taskState.agentConfig.outputFiles ?? [];
    const allFiles = [
      ...(Array.isArray(declaredOutputs) ? declaredOutputs : []),
      ...generatedPaths,
    ].filter(isNonEmptyString);
    const outputFilesArray = [...new Set(allFiles)];

    // Priority: explicit config > activeFiles flag > infer from file count
    const useMultipleOutputs =
      taskState.agentConfig.useMultipleOutputs ??
      taskState.activeFiles.output ??
      outputFilesArray.length > 1;

    await vscode.commands.executeCommand(command, {
      streamId,
      agent: taskState.agentConfig.agent,
      model: taskState.agentConfig.model,
      inputFile: taskState.agentConfig.inputFile,
      outputFiles: useMultipleOutputs ? outputFilesArray : [],
      useMultipleOutputs,
      skipProgressViewClear: true,
    });
  }

  private async withToolbarTaskState(
    streamId: StreamTabId,
    action: (taskState: WorkflowTaskState) => Promise<void>,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(streamId);
    if (!taskState || !isWorkflowTaskState(taskState)) {
      return;
    }

    await action(taskState);
  }

  private async executeWithBaseFile(
    file: string,
    base: string | undefined,
    actionName: string,
    execute: (file: string, base: string) => Thenable<unknown>,
  ): Promise<void> {
    if (!base) {
      this.logger.warn(
        this.channel,
        `${actionName} requested without a base path.`,
        {
          data: { file },
        },
      );
      return;
    }
    await execute(file, base);
  }

  private findOutputDirectory(
    runOutputs: Map<number, OutputFileInfo[]>,
  ): string | undefined {
    for (const infos of runOutputs.values()) {
      for (const info of infos) {
        const kind = info.location.kind;
        if (kind === 'runStorage' || kind === 'workspace') {
          return path.dirname(info.location.absolutePath);
        }
      }
    }
    return undefined;
  }

  private async processFollowup(
    data: {
      stream: StreamTabId;
      mode: 'chat' | 'workflow' | 'merge';
      agent: string;
      model: string;
      includeInstruction?: boolean;
      attachAgentOutputs?: boolean;
      initialQuestion?: string;
    },
    executeImmediately: boolean,
  ): Promise<void> {
    const {
      stream: streamId,
      mode,
      agent,
      model,
      includeInstruction,
      attachAgentOutputs,
      initialQuestion,
    } = data;

    const prereq = await this.validateFollowupPrerequisites(streamId, agent);
    if (!prereq) return;

    const { taskState, outputFiles } = prereq;
    const originalConfig = taskState.agentConfig;
    const originalInputs = [
      originalConfig.inputFile,
      ...originalConfig.inputFiles,
    ].filter(Boolean);

    const fileMapping = this.buildFollowupFileMapping(
      originalInputs,
      outputFiles,
    );
    if (fileMapping.size === 0) {
      this.logger.warn(this.channel, 'Followup: No file mappings found', {
        data: {
          streamId,
          originalInputs: originalInputs.length,
          outputs: outputFiles.length,
        },
      });
      await vscode.window.showWarningMessage(
        'Could not map output files to original inputs. File names may not match.',
      );
      return;
    }

    if (mode === 'merge') {
      await this.executeMergeDirectly(originalInputs, fileMapping, model);
      return;
    }

    try {
      const newTaskState = await this.buildFollowupTaskState(
        taskState,
        originalConfig,
        fileMapping,
        {
          mode,
          agent,
          model,
          includeInstruction,
          attachAgentOutputs,
          initialQuestion,
        },
      );

      await vscode.commands.executeCommand('texra.mainView.focus');
      await vscode.commands.executeCommand(
        'texra.restoreState',
        newTaskState,
        executeImmediately,
      );

      this.logger.info(
        this.channel,
        'Followup task configured via restoreState',
      );
    } catch (error) {
      this.logger.error(
        this.channel,
        `Failed to set up followup task: ${toErrorMessage(error)}`,
      );
      await vscode.window.showErrorMessage(
        `Failed to set up followup task: ${toErrorMessage(error)}`,
      );
    }
  }

  private async validateFollowupPrerequisites(
    streamId: StreamTabId,
    agent: string,
  ): Promise<{ taskState: WorkflowTaskState; outputFiles: string[] } | null> {
    const taskState = this.provider.state.getTaskState(streamId);
    if (!taskState || !isWorkflowTaskState(taskState)) {
      this.logger.warn(this.channel, 'Followup: No task state found', {
        data: { stream: streamId },
      });
      await vscode.window.showWarningMessage(
        'No task state found for this stream. Cannot set up followup.',
      );
      return null;
    }

    const agentEntry = getAgent(agent);
    if (!agentEntry) {
      this.logger.warn(this.channel, 'Followup: Agent not found in registry', {
        data: { agent },
      });
      await vscode.window.showWarningMessage(
        `Agent "${agent}" not found. Please select a valid agent.`,
      );
      return null;
    }

    const storageKey = this.provider.state.getActiveRunId(streamId);
    const runOutputs = storageKey
      ? this.provider.state.getRunOutputFiles(streamId, { storageKey })
      : null;
    const outputFiles = this.extractOutputFilePaths(runOutputs);

    if (outputFiles.length === 0) {
      this.logger.warn(this.channel, 'Followup: No output files found', {
        data: { stream: streamId },
      });
      await vscode.window.showWarningMessage(
        'No output files found. Cannot set up followup.',
      );
      return null;
    }

    return { taskState, outputFiles };
  }

  private buildFollowupFileMapping(
    originalInputs: string[],
    outputFiles: string[],
  ): Map<string, string> {
    const outputLocations = outputFiles.map((p) => pathToLocation(p));
    const inputLocations = originalInputs.map((p) => pathToLocation(p));
    const pathMapping = createFileMapping(
      inputLocations,
      outputLocations,
      'contains',
    );

    const fileMapping = new Map<string, string>();
    for (let i = 0; i < originalInputs.length; i++) {
      const absolutePath = originalInputs[i];
      const location = inputLocations[i];
      const comparablePath =
        location.kind !== 'external'
          ? location.relativePath
          : location.absolutePath;
      const output = pathMapping.get(comparablePath);
      if (output?.absolutePath) {
        fileMapping.set(absolutePath, output.absolutePath);
      }
    }
    return fileMapping;
  }

  private async buildFollowupTaskState(
    originalTaskState: WorkflowTaskState,
    originalConfig: AgentConfig,
    fileMapping: Map<string, string>,
    options: {
      mode: 'chat' | 'workflow';
      agent: string;
      model: string;
      includeInstruction?: boolean;
      attachAgentOutputs?: boolean;
      initialQuestion?: string;
    },
  ): Promise<TaskState> {
    const {
      mode,
      agent,
      model,
      includeInstruction,
      attachAgentOutputs,
      initialQuestion,
    } = options;
    const isChat = mode === 'chat';

    const mapOutputToRelative = (p: string): string =>
      WorkspaceFS.relativePath(fileMapping.get(p) ?? p);
    const keepOriginalRelative = (p: string): string =>
      WorkspaceFS.relativePath(p);

    const newInputFile = attachAgentOutputs
      ? keepOriginalRelative(originalConfig.inputFile)
      : mapOutputToRelative(originalConfig.inputFile);
    const newInputFiles = attachAgentOutputs
      ? originalConfig.inputFiles.map(keepOriginalRelative)
      : originalConfig.inputFiles.map(mapOutputToRelative);

    const outputsAsReference = attachAgentOutputs
      ? [...fileMapping.values()].map((p) => WorkspaceFS.relativePath(p))
      : [];

    const template = isChat
      ? CHAT_INSTRUCTION_TEMPLATE
      : WORKFLOW_CONTEXT_TEMPLATE;
    const originalAgentEntry = getAgent(originalConfig.agent);
    const context = await this.renderFollowupInstruction(
      template,
      originalConfig,
      originalAgentEntry,
      fileMapping,
      isChat ? initialQuestion : undefined,
    );

    const shouldAppendOriginal =
      !isChat && includeInstruction && originalConfig.instruction;
    const instruction = shouldAppendOriginal
      ? `${context}\n\n${originalConfig.instruction}`
      : context;

    const agentCategory = isChat
      ? AgentCategory.ToolUse
      : AgentCategory.Workflow;

    const mergedReferenceFiles = [
      ...(originalConfig.referenceFiles ?? []),
      ...outputsAsReference,
    ];

    const outputFiles = attachAgentOutputs
      ? [
          ...new Set(
            [originalConfig.inputFile, ...originalConfig.inputFiles]
              .filter(Boolean)
              .map((p) => WorkspaceFS.relativePath(p)),
          ),
        ]
      : originalConfig.outputFiles;

    const useMultipleOutputs =
      (attachAgentOutputs && outputFiles.length > 1) ||
      originalConfig.useMultipleOutputs;

    const newConfig = {
      ...originalConfig,
      agent,
      model,
      inputFile: newInputFile,
      inputFiles: newInputFiles,
      outputFiles,
      useMultipleOutputs,
      referenceFiles: mergedReferenceFiles,
      instruction,
      agentCategory,
    } as AgentConfig;

    if (isChat) {
      return { agentConfig: newConfig } as TaskState;
    }

    const activeFiles = {
      ...originalTaskState.activeFiles,
      ...(outputsAsReference.length > 0 && { reference: true }),
      ...(attachAgentOutputs && outputFiles.length > 0 && { output: true }),
    };

    return {
      agentConfig: newConfig,
      activeFiles,
    } as TaskState;
  }

  private async renderFollowupInstruction(
    template: string,
    originalConfig: AgentConfig,
    originalAgentEntry: ReturnType<typeof getAgent>,
    fileMapping: Map<string, string>,
    initialQuestion?: string,
  ): Promise<string> {
    const toRelativePaths = (files: string[] | undefined) =>
      files
        ?.filter(Boolean)
        .map((p) => WorkspaceFS.relativePath(p))
        .join(', ') || undefined;

    const originalInputs = [
      originalConfig.inputFile,
      ...originalConfig.inputFiles,
    ].filter(Boolean);

    const agentInfo = originalAgentEntry?.description
      ? `${originalConfig.agent} - ${originalAgentEntry.description}`
      : originalConfig.agent;

    const vars: FollowupInstructionVars = {
      agentInfo,
      model: originalConfig.model || undefined,
      instruction: originalConfig.instruction || undefined,
      inputFiles: toRelativePaths(originalInputs),
      referenceFiles: toRelativePaths(originalConfig.referenceFiles),
      auxiliaryFiles: toRelativePaths(originalConfig.auxiliaryFiles),
      mediaFiles: toRelativePaths(originalConfig.mediaFiles),
      outputFiles: toRelativePaths([...fileMapping.values()]),
      question: initialQuestion,
    };

    return renderPrompt(template, vars as Record<string, unknown>);
  }

  private async executeMergeDirectly(
    originalInputs: string[],
    fileMapping: Map<string, string>,
    model: string,
  ): Promise<void> {
    const filePairs: { baseFile: string; editedFile: string }[] = [];
    for (const inputFile of originalInputs) {
      const outputFile = fileMapping.get(inputFile);
      if (outputFile) {
        filePairs.push({
          baseFile: inputFile,
          editedFile: outputFile,
        });
      }
    }

    if (filePairs.length === 0) {
      await vscode.window.showErrorMessage(
        'Cannot set up merge: no output files found for any input files.',
      );
      return;
    }

    this.logger.info(this.channel, 'Executing merge directly');

    if (filePairs.length === 1) {
      await safeExecuteCommand('texra.merge', [
        undefined,
        filePairs[0].baseFile,
        filePairs[0].editedFile,
        model,
      ]);
    } else {
      const baseFiles = filePairs.map((p) => p.baseFile);
      const editedFiles = filePairs.map((p) => p.editedFile);

      await safeExecuteCommand('texra.execute', [
        {
          config: {
            agent: 'merge',
            model,
            inputFile: baseFiles[0],
            inputFiles: baseFiles.slice(1),
            editedFile: editedFiles[0],
            editedFiles: editedFiles.slice(1),
            outputFiles: baseFiles,
            instruction: '',
            useMultipleOutputs: true,
          },
        },
      ]);
    }
  }

  private extractOutputFilePaths(
    runOutputs: Map<number, OutputFileInfo[]> | null | undefined,
  ): string[] {
    if (!runOutputs) return [];
    return [...runOutputs.values()].flatMap((infos) =>
      infos
        .map((info) => info.location?.absolutePath)
        .filter((path): path is string => Boolean(path)),
    );
  }
}
