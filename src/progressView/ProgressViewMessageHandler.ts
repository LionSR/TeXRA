import * as path from 'path';
import * as vscode from 'vscode';

import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { getAgent, computeAgentOptionsData } from '@agent/index/agentRegistry';
import { proposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { toErrorMessage } from '@common/errors';
import { RecordingManager } from '@common/managers';
import {
  BaseViewMessageHandler,
  MessageHandler,
  PROGRESS_VIEW_COMMANDS,
} from '@common/webview';
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
  AgentProposalActionMessageSchema,
  type ExecutionId,
  type OutputFileInfo,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
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
import {
  ApprovalActionMessageSchema,
  BaseFileCommandMessageSchema,
  BashApprovalActionMessageSchema,
  CompareMessageSchema,
  FileCommandMessageSchema,
  FilterStreamsMessageSchema,
  FollowupTaskMessageSchema,
  InfoMessageSchema,
  OpenLabelMessageSchema,
  PolishFollowUpMessageSchema,
  RetryStreamMessageSchema,
  SendFollowUpMessageSchema,
  SortStreamsMessageSchema,
  StreamMessageSchema,
} from '@webview/types/messages';

import type { ProgressViewProvider } from './ProgressViewProvider';

export class ProgressViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly recordingManager: RecordingManager;
  private readonly modelOutputBackups = new Map<
    string,
    { content: string; streamId: StreamTabId }
  >();

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
  }

  protected createHandlers(): Record<
    string,
    MessageHandler<vscode.WebviewView | vscode.WebviewPanel>
  > {
    return {
      // Common handlers
      [PROGRESS_VIEW_COMMANDS.THEME_SET]: this.handleTheme.bind(this),
      [PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET]: this.handleDebugMode.bind(this),
      [PROGRESS_VIEW_COMMANDS.WEBVIEW_READY]:
        this.handleWebviewReady.bind(this),

      // Stream management
      [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]:
        this.handleSwitchStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]:
        this.handleDeleteStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: this.handleDeleteAll.bind(this),
      [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: this.handleStopStream.bind(this),

      // Actions
      [PROGRESS_VIEW_COMMANDS.RESUME]: this.handleResume.bind(this),
      [PROGRESS_VIEW_COMMANDS.RUN_NEW]: this.handleRunNew.bind(this),
      [PROGRESS_VIEW_COMMANDS.DIFF_STREAM]: this.handleDiffStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.PACK_STREAM]: this.handlePackStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.CLEAN_STREAM]: this.handleCleanStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.SORT_STREAMS]: this.handleSortStreams.bind(this),
      [PROGRESS_VIEW_COMMANDS.FILTER_STREAMS]:
        this.handleFilterStreams.bind(this),
      [PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST]:
        this.handleRetryStreamRequest.bind(this),
      [PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST]:
        this.handleCancelRetryRequest.bind(this),
      [PROGRESS_VIEW_COMMANDS.RESTORE_STATE]:
        this.handleRestoreState.bind(this),
      [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]:
        this.handleSendFollowUp.bind(this),
      [PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE]:
        this.handleOpenTaskStorage.bind(this),
      [PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP]:
        this.handlePolishFollowUp.bind(this),
      [PROGRESS_VIEW_COMMANDS.START_RECORDING]: async (_m, w) =>
        this.recordingManager.start(w),
      [PROGRESS_VIEW_COMMANDS.STOP_RECORDING]: async (_m, w) =>
        this.recordingManager.stop(w),
      [PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]:
        this.handleShowInformationMessage.bind(this),
      [PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION]:
        this.handleToolEditApprovalAction.bind(this),
      [PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS]:
        this.handleToggleToolEditApprovalBypass.bind(this),
      [PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]:
        this.handleAgentProposalAction.bind(this),
      [PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION]:
        this.handleBashApprovalAction.bind(this),

      // Profile
      [PROGRESS_VIEW_COMMANDS.OPEN_PROFILE]: this.handleOpenProfile.bind(this),

      // Memory
      [PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW]:
        this.handleOpenMemoryView.bind(this),

      // Followup task
      [PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS]:
        this.handleGetFollowupOptions.bind(this),
      [PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP]:
        this.handleSetupFollowup.bind(this),
      [PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP]: this.handleRunFollowup.bind(this),

      // File operations
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: this.handleOpenFile.bind(this),
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]:
        this.handleOpenFileCompile.bind(this),
      [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]:
        this.handleCompareOriginal.bind(this),
      [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]:
        this.handleComparePrevious.bind(this),
      [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: this.handleAcceptFile.bind(this),
      [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: this.handleMergeFile.bind(this),
      [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]:
        this.handleLatexdiffFile.bind(this),
      [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: this.handleOpenLabel.bind(this),
    };
  }

  protected override async handleWebviewReady(message: unknown): Promise<void> {
    const webviewView = this.getActiveView();
    if (webviewView) {
      await super.handleWebviewReady(message, webviewView);
      this.provider.markWebviewReady(webviewView);
    }
  }

  private async handleSwitchStream(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'switchStream',
      async ({ stream: streamId }) => {
        this.provider.setActiveStream(streamId);
      },
    );
  }

  private async handleDeleteStream(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'deleteStream',
      async ({ stream: streamId }) => {
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
      },
    );
  }

  private async handleDeleteAll(_message: unknown): Promise<void> {
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

  private async handleStopStream(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'stopStream',
      async ({ stream: streamId }) => {
        await vscode.commands.executeCommand('texra.stopAgent', streamId);
      },
    );
  }

  private async handleResume(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'resumeStream',
      async ({ stream: streamId }) => {
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
      },
    );
  }

  private async handleRunNew(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'runNew',
      async ({ stream: streamId }) => {
        const taskState = this.provider.state.getTaskState(streamId);
        if (!taskState) {
          return;
        }
        await safeExecuteCommand('texra.execute', [taskState.agentConfig]);
      },
    );
  }

  private async handleRetryStreamRequest(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      RetryStreamMessageSchema,
      message,
      'retryStreamRequest',
      async ({ stream: streamId, feedback }) => {
        const success = retryCoordinator.triggerRetry(streamId, feedback);
        if (!success) {
          await vscode.window.showInformationMessage(
            'No retryable request is available for this stream yet.',
          );
        }
      },
    );
  }

  private async handleCancelRetryRequest(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'cancelRetryRequest',
      ({ stream: streamId }) => {
        retryCoordinator.cancelRetry(streamId);
      },
    );
  }

  private async handleDiffStream(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'diffStream',
      async ({ stream: streamId }) => {
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
      },
    );
  }

  private async handlePackStream(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'packStream',
      async ({ stream: streamId }) => {
        await this.withToolbarTaskState(streamId, async (taskState) => {
          await this.handleFileOperation(streamId, taskState, 'texra.pack');
        });
      },
    );
  }

  private async handleCleanStream(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'cleanStream',
      async ({ stream: streamId }) => {
        await this.withToolbarTaskState(streamId, async (taskState) => {
          await this.handleFileOperation(streamId, taskState, 'texra.clean');
        });
      },
    );
  }

  private async handleSortStreams(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      SortStreamsMessageSchema,
      message,
      'sortStreams',
      async ({ sortBy }) => {
        this.provider.state.streamSortOrder = sortBy;
        this.provider.updateWebview();
      },
    );
  }

  private async handleFilterStreams(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      FilterStreamsMessageSchema,
      message,
      'filterStreams',
      async ({ filter }) => {
        this.provider.state.agentCategoryFilter = filter;
        this.provider.updateWebview();
      },
    );
  }

  private async handleRestoreState(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'restoreState',
      async ({ stream: streamId }) => {
        const taskState = this.provider.state.getTaskState(streamId);
        if (taskState) {
          await vscode.commands.executeCommand('texra.restoreState', taskState);
        }
      },
    );
  }

  private async handleSendFollowUp(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      SendFollowUpMessageSchema,
      message,
      'sendFollowUp',
      async ({ stream: streamId, text }) => {
        await vscode.commands.executeCommand('texra.sendFollowUp', {
          stream: streamId,
          text,
        });
      },
    );
  }

  private async handlePolishFollowUp(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      PolishFollowUpMessageSchema,
      message,
      'polishFollowUp',
      async ({ stream: streamId, text }) => {
        const taskState = this.provider.state.getTaskState(streamId);
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
              const result = await polishTextWithAI(text, fileContext);
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
                { data: error instanceof Error ? error : undefined },
              );
            }
          },
        );
      },
    );
  }

  private async handleShowInformationMessage(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      InfoMessageSchema,
      message,
      'infoMessage',
      async (data) => {
        await vscode.window.showInformationMessage(data.text);
      },
    );
  }

  private async handleToolEditApprovalAction(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      ApprovalActionMessageSchema,
      message,
      'approvalAction',
      handleProgressViewToolEditApprovalAction,
    );
  }

  private async handleToggleToolEditApprovalBypass(
    message: unknown,
  ): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'toggleToolEditApprovalBypass',
      async ({ stream: streamId }) => {
        const isNowEnabled = toggleToolEditApprovalSessionBypass(streamId);
        const infoMessage = isNowEnabled
          ? 'YOLO mode enabled: Tool actions will be auto-approved for this stream.'
          : 'YOLO mode disabled: Tool actions will prompt for approval.';
        await vscode.window.showInformationMessage(infoMessage);
      },
    );
  }

  private async handleBashApprovalAction(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      BashApprovalActionMessageSchema,
      message,
      'bashApprovalAction',
      handleProgressViewBashApprovalAction,
    );
  }

  private async handleAgentProposalAction(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      AgentProposalActionMessageSchema,
      message,
      'agentProposalAction',
      async ({ proposalId, action, feedback }) => {
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
      },
    );
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
      { data: { agent: proposal.agent } },
    );
  }

  private async handleOpenTaskStorage(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      StreamMessageSchema,
      message,
      'openTaskStorage',
      async ({ stream: streamId }) => {
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
      },
    );
  }

  private async handleOpenFile(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      FileCommandMessageSchema,
      message,
      'openFile',
      async ({ file, line }) => {
        await vscode.commands.executeCommand('texra.openFile', file, line);
      },
    );
  }

  private async handleOpenFileCompile(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      FileCommandMessageSchema,
      message,
      'openFileCompile',
      async ({ file }) => {
        await vscode.commands.executeCommand('texra.openFileCompile', file);
      },
    );
  }

  private async handleCompareOriginal(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      BaseFileCommandMessageSchema,
      message,
      'compareOriginal',
      async ({ file, base }) => {
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
      },
    );
  }

  private async handleComparePrevious(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      CompareMessageSchema,
      message,
      'comparePrevious',
      async ({ file, base, prev }) => {
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
      },
    );
  }

  private async handleAcceptFile(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      BaseFileCommandMessageSchema,
      message,
      'acceptFile',
      async ({ file, base }) => {
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
      },
    );
  }

  private async handleMergeFile(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      BaseFileCommandMessageSchema,
      message,
      'mergeFile',
      async ({ file, base }) => {
        await this.executeWithBaseFile(
          file,
          base,
          'Merge',
          (targetFile, baseFile) =>
            vscode.commands.executeCommand(
              'texra.merge',
              undefined,
              baseFile,
              targetFile,
            ),
        );
      },
    );
  }

  private async handleLatexdiffFile(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      BaseFileCommandMessageSchema,
      message,
      'latexdiffFile',
      async ({ file, base }) => {
        await this.executeWithBaseFile(
          file,
          base,
          'Latexdiff',
          (targetFile, baseFile) =>
            vscode.commands.executeCommand(
              'texra.latexdiff',
              undefined,
              baseFile,
              targetFile,
            ),
        );
      },
    );
  }

  private async handleOpenLabel(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      OpenLabelMessageSchema,
      message,
      'openLabel',
      async ({ label }) => {
        await vscode.commands.executeCommand('texra.openLabel', label);
      },
    );
  }

  private async handleOpenProfile(): Promise<void> {
    await vscode.commands.executeCommand('texra.auth.viewProfile');
  }

  private async handleOpenMemoryView(): Promise<void> {
    await vscode.commands.executeCommand('texra.showMemory');
  }

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
        { data: { file } },
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

  private async handleGetFollowupOptions(_message: unknown): Promise<void> {
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
        'Failed to get followup options',
        toErrorMessage(error),
      );
    }
  }

  private async handleSetupFollowup(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      FollowupTaskMessageSchema,
      message,
      'setupFollowup',
      async (data) => this.processFollowup(data, false),
    );
  }

  private async handleRunFollowup(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      FollowupTaskMessageSchema,
      message,
      'runFollowup',
      async (data) => this.processFollowup(data, true),
    );
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
        'Failed to set up followup task',
        toErrorMessage(error),
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

    const newAgentEntry = getAgent(agent);
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
