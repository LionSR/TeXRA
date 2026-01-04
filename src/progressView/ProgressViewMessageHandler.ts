// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - common

// Local imports - progress view
import {
  AgentTypeFilter,
  isAgentTypeFilter,
} from '@agent/types/AgentStreamTypes';
// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
// Internal imports
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { toErrorMessage } from '@common/errors';
import { RecordingManager } from '@common/managers';
import { BaseViewMessageHandler, MessageHandler } from '@common/webview';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview';
import { normalizeRunId } from '@common/constants/runIds';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  isWorkflowTaskState,
  isToolUseTaskState,
  type WorkflowTaskState,
  type TaskState,
} from '@logger/TaskState';
import {
  handleProgressViewToolEditApprovalAction,
  resetToolEditApprovalSessionBypass,
} from '@tools/approval/toolEditApproval';
import { pathToLocation } from '@utils/files';
import { isNonEmptyString } from '@utils/core';
import { ensureRunDir, getRunDir } from '@utils/files/taskRunStorage';
import {
  buildFileContextFromTaskState,
  polishTextWithAI,
} from '@utils/text/textEnhancementUtils';
import {
  PolishFollowUpMessageSchema,
  InfoMessageSchema,
  ApprovalActionMessageSchema,
} from '@webview/types/messages';

// Type imports
import type { ProgressViewProvider } from './ProgressViewProvider';

interface FileCommandMessage {
  file: string;
}

interface BaseFileCommandMessage extends FileCommandMessage {
  base?: string;
}

interface CompareMessage extends BaseFileCommandMessage {
  prev?: string;
}

export class ProgressViewMessageHandler extends BaseViewMessageHandler {
  private readonly recordingManager: RecordingManager;

  constructor(
    private readonly provider: ProgressViewProvider,
    context: vscode.ExtensionContext,
  ) {
    // Enable activeView tracking - getActiveView() is inherited from base class
    super('ProgressView', { trackActiveView: true });
    this.recordingManager = new RecordingManager(context, {
      recordingStartedCommand: PROGRESS_VIEW_COMMANDS.RECORDING_STARTED,
      recordingStoppedCommand: PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED,
      recordingErrorCommand: PROGRESS_VIEW_COMMANDS.RECORDING_ERROR,
      transcriptionCommand: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED,
      progressTitle: 'Transcribing follow-up message',
    });
  }

  private async deleteSessionSnapshot(_stream: StreamTabId): Promise<void> {
    // PersistedFlow handles state cleanup automatically.
    // ExecutionKVStore cleanup is managed by the flow lifecycle.
  }

  protected createHandlers(): Record<
    string,
    MessageHandler<vscode.WebviewView>
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
      [PROGRESS_VIEW_COMMANDS.RUN_AGAIN]: this.handleRunAgain.bind(this),
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
      [PROGRESS_VIEW_COMMANDS.RESET_TOOL_EDIT_APPROVAL_BYPASS]:
        this.handleResetToolEditApprovalBypass.bind(this),

      // Profile
      [PROGRESS_VIEW_COMMANDS.OPEN_PROFILE]: this.handleOpenProfile.bind(this),

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

  // Handler implementations
  /**
   * Override to notify the provider when webview is ready.
   * This allows the provider to process any pending updates that
   * were queued while the webview was initializing.
   */
  protected override async handleWebviewReady(message: any): Promise<void> {
    const webviewView = this.getActiveView();
    if (webviewView) {
      await super.handleWebviewReady(message, webviewView);
    }
    this.provider.markWebviewReady();
  }

  private async handleSwitchStream(message: any): Promise<void> {
    this.provider.setActiveStream(message.stream);
  }

  private async handleDeleteStream(message: any): Promise<void> {
    // Delete persisted session data if any
    await this.deleteSessionSnapshot(message.stream);
    await this.provider.state.clearStream(message.stream);
    // Force rebuild since we deleted a stream
    this.provider.updateWebview({ forceRebuild: true });
  }

  private async handleDeleteAll(_message: any): Promise<void> {
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

    // Delete all persisted session data
    const allStates = this.provider.state.getAllTaskStates();
    for (const [stream] of allStates) {
      await this.deleteSessionSnapshot(stream);
    }

    await this.provider.state.clearAll();
    // Force rebuild since we deleted all streams
    this.provider.updateWebview({ forceRebuild: true });
  }

  private async handleStopStream(message: any): Promise<void> {
    await vscode.commands.executeCommand('texra.stopAgent', message.stream);
  }

  private async handleRunAgain(message: any): Promise<void> {
    const taskState = this.provider.state.getTaskState(message.stream);
    if (!taskState) {
      return;
    }

    const executionId = this.provider.state.getExecutionId(message.stream);
    if (!executionId) {
      this.logger.warn(
        this.channel,
        `Resume requested for ${message.stream} without an execution ID`,
      );
      return;
    }

    // Handle both workflow and tool-use sessions
    // Both task state types have agentConfig which is all we need for resume
    await safeExecuteCommand('texra.execute', [
      {
        config: taskState.agentConfig,
        executionId,
        stream: message.stream,
        resume: true,
      },
    ]);
  }

  private async handleRunNew(message: any): Promise<void> {
    const taskState = this.provider.state.getTaskState(message.stream);
    if (!taskState) {
      return;
    }

    // Handle both workflow and tool-use sessions
    // Both task state types have agentConfig which is all we need to start new run
    await safeExecuteCommand('texra.execute', [taskState.agentConfig]);
  }

  private async handleRetryStreamRequest(message: any): Promise<void> {
    // triggerRetry is synchronous, no await needed
    const success = retryCoordinator.triggerRetry(message.stream);
    if (!success) {
      await vscode.window.showInformationMessage(
        'No retryable request is available for this stream yet.',
      );
    }
  }

  private async handleCancelRetryRequest(message: any): Promise<void> {
    retryCoordinator.cancelRetry(message.stream);
  }

  private async handleDiffStream(message: any): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      const executionId = this.provider.state.getExecutionId(message.stream);
      const activeRunId = this.provider.state.getActiveRunId(message.stream);
      // storageKey is for logical indexing (finding file metadata in progress view state).
      // For workflow agents: activeRunId = task group ID; for tool-use: executionId.
      // Note: Physical file paths use executionId (see runId below), not storageKey.
      const storageKey = normalizeRunId(activeRunId ?? executionId);
      const runOutputs = this.provider.state.getRunOutputFiles(message.stream, {
        storageKey,
      });
      const outputsByRound = runOutputs
        ? Object.fromEntries(runOutputs.entries())
        : undefined;

      await vscode.commands.executeCommand('texra.runLatexdiff', {
        agent: taskState.agentConfig.agent,
        model: taskState.agentConfig.model,
        inputFile: taskState.agentConfig.inputFile,
        outputFiles: taskState.agentConfig.outputFiles,
        outputFilesActive: taskState.activeFiles.output,
        streamId: message.stream,
        // executionId is for file system paths (taskRuns/<executionId>/...)
        // storageKey is for logical storage indexing - different concepts
        runId: executionId,
        outputsByRound,
      });
    });
  }

  private async handlePackStream(message: any): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      await this.handleFileOperation(message.stream, taskState, 'texra.pack');
    });
  }

  private async handleCleanStream(message: any): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      await this.handleFileOperation(message.stream, taskState, 'texra.clean');
    });
  }

  private async handleSortStreams(message: any): Promise<void> {
    this.provider.state.streamSortOrder = message.sortBy ?? 'time';
    this.provider.updateWebview();
  }

  private async handleFilterStreams(message: any): Promise<void> {
    const requestedFilter = message.filter;
    const filter: AgentTypeFilter = isAgentTypeFilter(requestedFilter)
      ? requestedFilter
      : 'all';
    this.provider.state.agentTypeFilter = filter;
    this.provider.updateWebview();
  }

  private async handleRestoreState(message: any): Promise<void> {
    const taskState = this.provider.state.getTaskState(message.stream);
    if (taskState) {
      await vscode.commands.executeCommand('texra.restoreState', taskState);
    }
  }

  private async handleSendFollowUp(message: any): Promise<void> {
    await vscode.commands.executeCommand('texra.sendFollowUp', {
      stream: message.stream,
      text: message.text,
    });
  }

  private async handlePolishFollowUp(message: unknown): Promise<void> {
    await this.withValidatedMessage(
      PolishFollowUpMessageSchema,
      message,
      'polishFollowUp',
      async ({ stream, text }) => {
        const taskState = this.provider.state.getTaskState(
          stream as StreamTabId,
        ) as TaskState | undefined;
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

  private async handleResetToolEditApprovalBypass(): Promise<void> {
    resetToolEditApprovalSessionBypass();
    await vscode.window.showInformationMessage(
      'Tool edit approvals will prompt again for this session.',
    );
  }

  private async handleOpenTaskStorage(message: any): Promise<void> {
    const stream = message.stream as StreamTabId | undefined;
    if (!stream) {
      await vscode.window.showInformationMessage(
        'No workspace storage folder is available for this run yet.',
      );
      return;
    }

    const resolvedRunId = this.provider.state.resolveRunId(stream, undefined, {
      persist: false,
    });
    // Only fetch output files if we have a resolved run ID
    const storageKey = resolvedRunId ? normalizeRunId(resolvedRunId) : null;
    const runOutputs = storageKey
      ? this.provider.state.getRunOutputFiles(stream, { storageKey })
      : undefined;

    // executionId is the physical directory name: taskRuns/<executionId>/
    // For workflow agents, storageKey (task group ID) differs from executionId,
    // but files are always written to the executionId directory.
    const executionId = this.provider.state.getExecutionId(stream);

    try {
      let directoryToReveal: string | undefined;

      if (executionId) {
        await ensureRunDir(executionId);
        directoryToReveal = getRunDir(executionId);
      } else if (runOutputs) {
        // Defensive fallback: executionId and outputFiles are persisted independently,
        // so edge cases (data migration, partial state) could leave files without executionId.
        // Extract directory from actual file paths.
        for (const infos of runOutputs.values()) {
          for (const info of infos) {
            if (
              info.location.kind === 'runStorage' ||
              info.location.kind === 'workspace'
            ) {
              directoryToReveal = path.dirname(info.location.absolutePath);
              break;
            }
          }
          if (directoryToReveal) break;
        }
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
        `Failed to open task storage for stream ${stream}, executionId ${executionId ?? 'unknown'}: ${errorMessage}`,
        {
          data: {
            error: error instanceof Error ? error : undefined,
            stream,
            executionId,
          },
        },
      );
      await vscode.window.showErrorMessage(
        'Unable to open the workspace storage folder for this run.',
      );
    }
  }

  private async handleOpenFile(message: FileCommandMessage): Promise<void> {
    await vscode.commands.executeCommand('texra.openFile', message.file);
  }

  private async handleOpenFileCompile(
    message: FileCommandMessage,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openFileCompile', message.file);
  }

  private async handleCompareOriginal(
    message: BaseFileCommandMessage,
  ): Promise<void> {
    if (!message.base) {
      this.logger.warn(
        this.channel,
        'Compare original requested without a base path.',
        { data: { file: message.file } },
      );
      return;
    }

    await vscode.commands.executeCommand(
      'texra.compare',
      pathToLocation(''), // inputFile unused
      pathToLocation(message.base),
      pathToLocation(message.file),
    );
  }

  private async handleComparePrevious(message: CompareMessage): Promise<void> {
    const previousFile = message.prev ?? message.base;

    if (previousFile) {
      await vscode.commands.executeCommand(
        'texra.latexdiff',
        undefined,
        previousFile,
        message.file,
      );
    }

    await vscode.commands.executeCommand(
      'texra.compare',
      pathToLocation(''), // inputFile unused
      pathToLocation(previousFile || ''),
      pathToLocation(message.file),
    );
  }

  private async handleAcceptFile(
    message: BaseFileCommandMessage,
  ): Promise<void> {
    if (!message.base) {
      this.logger.warn(this.channel, 'Accept requested without a base path.', {
        data: { file: message.file },
      });
      return;
    }

    await vscode.commands.executeCommand(
      'texra.acceptEdited',
      pathToLocation(''), // inputFile unused
      pathToLocation(message.base),
      pathToLocation(message.file),
    );
  }

  private async handleMergeFile(
    message: BaseFileCommandMessage,
  ): Promise<void> {
    if (!message.base) {
      this.logger.warn(this.channel, 'Merge requested without a base path.', {
        data: { file: message.file },
      });
      return;
    }

    await vscode.commands.executeCommand(
      'texra.merge',
      undefined,
      message.base,
      message.file,
    );
  }

  private async handleLatexdiffFile(
    message: BaseFileCommandMessage,
  ): Promise<void> {
    if (!message.base) {
      this.logger.warn(
        this.channel,
        'Latexdiff requested without a base path.',
        { data: { file: message.file } },
      );
      return;
    }

    await vscode.commands.executeCommand(
      'texra.latexdiff',
      undefined,
      message.base,
      message.file,
    );
  }

  private async handleOpenLabel(message: any): Promise<void> {
    await vscode.commands.executeCommand('texra.openLabel', message.label);
  }

  private async handleOpenProfile(): Promise<void> {
    await vscode.commands.executeCommand('texra.auth.viewProfile');
  }

  private async handleFileOperation(
    stream: string,
    taskState: WorkflowTaskState,
    command: 'texra.pack' | 'texra.clean',
  ): Promise<void> {
    const resolvedRunId = this.provider.state.resolveRunId(stream, undefined, {
      persist: false,
    });
    const generatedPaths = this.provider.state.outputFiles.getKnownFilePaths(
      stream,
      {
        storageKey: resolvedRunId ? normalizeRunId(resolvedRunId) : null,
        workspaceOnly: true,
      },
    );
    const allFiles = new Set<string>();

    const declaredOutputs = Array.isArray(taskState.agentConfig.outputFiles)
      ? taskState.agentConfig.outputFiles
      : [];
    for (const file of declaredOutputs) {
      if (isNonEmptyString(file)) {
        allFiles.add(file);
      }
    }

    for (const file of generatedPaths) {
      if (isNonEmptyString(file)) {
        allFiles.add(file);
      }
    }

    const outputFilesArray = [...allFiles];
    const useMultipleOutputs =
      taskState.agentConfig.useMultipleOutputs ??
      taskState.activeFiles.output ??
      outputFilesArray.length > 1;
    await vscode.commands.executeCommand(command, {
      streamId: stream,
      agent: taskState.agentConfig.agent,
      model: taskState.agentConfig.model,
      inputFile: taskState.agentConfig.inputFile,
      outputFiles: useMultipleOutputs ? outputFilesArray : [],
      useMultipleOutputs,
      skipProgressViewClear: true,
    });
  }

  /**
   * Fetches a task state for a toolbar action, short-circuiting execution for tool-use agents.
   * @param stream - The stream identifier whose task state should be fetched.
   * @param action - The callback to execute when a valid workflow task state is available.
   */
  private async withToolbarTaskState(
    stream: string,
    action: (taskState: WorkflowTaskState) => Promise<void>,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(stream);
    if (!taskState || !isWorkflowTaskState(taskState)) {
      return;
    }

    await action(taskState);
  }
}
