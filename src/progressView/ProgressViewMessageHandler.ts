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
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';
// Internal imports
import { ToolUseSessionPersistence } from '@agent/toolUse/ToolUseSessionPersistence';
import { toErrorMessage } from '@common/errors';
import { BaseViewMessageHandler, MessageHandler } from '@common/webview';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview';
import {
  isWorkflowTaskState,
  type WorkflowTaskState,
  type TaskState,
} from '@logger/TaskState';
import {
  handleProgressViewToolEditApprovalAction,
  resetToolEditApprovalSessionBypass,
} from '@tools/approval/toolEditApproval';
import {
  ensureRunDir,
  getRunDir,
  normalizeExecutionId,
} from '@utils/files/taskRunStorage';
import { safeExecuteCommand } from '@utils/system/commandUtils';
import {
  buildFileContextFromTaskState,
  polishTextWithAI,
} from '@utils/text/textEnhancementUtils';
import { RecordingManager } from '@webview/managers/RecordingManager';

// @ts-ignore - Import JavaScript module

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
  private activeView: vscode.WebviewView | undefined;

  constructor(
    private readonly provider: ProgressViewProvider,
    context: vscode.ExtensionContext,
  ) {
    super('ProgressView');
    this.recordingManager = new RecordingManager(context, {
      recordingStartedCommand: PROGRESS_VIEW_COMMANDS.RECORDING_STARTED,
      recordingStoppedCommand: PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED,
      recordingErrorCommand: PROGRESS_VIEW_COMMANDS.RECORDING_ERROR,
      transcriptionCommand: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED,
      progressTitle: 'Transcribing follow-up message',
    });
  }

  public override async handleMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.activeView = webviewView;
    await super.handleMessage(message, webviewView);
  }

  private getActiveView(): vscode.WebviewView | undefined {
    if (!this.activeView) {
      this.logger.warn(this.channel, 'No active progress view available');
      return undefined;
    }

    return this.activeView;
  }

  private async deleteSessionSnapshot(stream: StreamTabId): Promise<void> {
    const executionId = this.provider.state.getExecutionId(stream);
    if (executionId) {
      await ToolUseSessionPersistence.clearPersistedSnapshot(executionId);
    }
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
    this.provider.updateWebview();
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
    this.provider.updateWebview();
  }

  private async handleStopStream(message: any): Promise<void> {
    await vscode.commands.executeCommand('texra.stopAgent', message.stream);
  }

  private async handleRunAgain(message: any): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      const executionId = this.provider.state.getExecutionId(message.stream);
      if (!executionId) {
        this.logger.warn(
          this.channel,
          `Resume requested for ${message.stream} without an execution ID`,
        );
        return;
      }

      await safeExecuteCommand('texra.execute', [
        {
          config: taskState.agentConfig,
          executionId,
          stream: message.stream,
          resume: true,
        },
      ]);
    });
  }

  private async handleRunNew(message: any): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      await safeExecuteCommand('texra.execute', [taskState.agentConfig]);
    });
  }

  private async handleDiffStream(message: any): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      const executionId = this.provider.state.getExecutionId(message.stream);
      const runOutputs = this.provider.state.getRunOutputFiles(message.stream, {
        executionId,
        runId: this.provider.state.getActiveRunId(message.stream),
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
        runId:
          executionId ?? this.provider.state.getActiveRunId(message.stream),
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

  private async handlePolishFollowUp(message: any): Promise<void> {
    const stream = message.stream as StreamTabId | undefined;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!stream || !text) {
      return;
    }

    const taskState = this.provider.state.getTaskState(stream) as
      | TaskState
      | undefined;
    if (!taskState) {
      return;
    }

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
          progress.report({ message: 'Applying changes...', increment: 60 });

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
            error instanceof Error ? error : undefined,
          );
        }
      },
    );
  }

  private async handleShowInformationMessage(message: any): Promise<void> {
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (!text) {
      return;
    }
    await vscode.window.showInformationMessage(text);
  }

  private async handleToolEditApprovalAction(message: any): Promise<void> {
    const requestId =
      typeof message?.requestId === 'string' ? message.requestId : '';
    const action = typeof message?.action === 'string' ? message.action : '';
    if (!requestId || !action) {
      return;
    }

    await handleProgressViewToolEditApprovalAction({
      requestId,
      action,
      note: typeof message?.note === 'string' ? message.note : undefined,
    });
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
    const normalizedRunId = normalizeExecutionId(resolvedRunId);
    const runOutputs = this.provider.state.getRunOutputFiles(stream, {
      runId: resolvedRunId ?? undefined,
      executionId: normalizedRunId,
    });

    const executionIdFromRun =
      normalizedRunId ?? this.extractExecutionIdFromOutputs(runOutputs);
    const executionId =
      executionIdFromRun ?? this.provider.state.getExecutionId(stream);

    try {
      let directoryToReveal: string | undefined;

      const safeExecutionId = normalizeExecutionId(executionId);
      if (safeExecutionId) {
        await ensureRunDir(safeExecutionId);
        directoryToReveal = getRunDir(safeExecutionId);
      } else if (runOutputs) {
        directoryToReveal = this.findPreferredOutputDirectory(runOutputs);
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
        error instanceof Error ? error : undefined,
        undefined,
        undefined,
        {
          stream,
          executionId,
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
        undefined,
        undefined,
        undefined,
        { file: message.file },
      );
      return;
    }

    await vscode.commands.executeCommand(
      'texra.compare',
      undefined,
      message.base,
      message.file,
    );
  }

  private async handleComparePrevious(message: CompareMessage): Promise<void> {
    const previousFile = message.prev || message.base;

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
      undefined,
      previousFile,
      message.file,
    );
  }

  private async handleAcceptFile(
    message: BaseFileCommandMessage,
  ): Promise<void> {
    if (!message.base) {
      this.logger.warn(
        this.channel,
        'Accept requested without a base path.',
        undefined,
        undefined,
        undefined,
        { file: message.file },
      );
      return;
    }

    await vscode.commands.executeCommand(
      'texra.acceptEdited',
      undefined,
      message.base,
      message.file,
    );
  }

  private async handleMergeFile(
    message: BaseFileCommandMessage,
  ): Promise<void> {
    if (!message.base) {
      this.logger.warn(
        this.channel,
        'Merge requested without a base path.',
        undefined,
        undefined,
        undefined,
        { file: message.file },
      );
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
        undefined,
        undefined,
        undefined,
        { file: message.file },
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
        runId: resolvedRunId ?? undefined,
        workspaceOnly: true,
      },
    );
    const allFiles = new Set<string>();

    const declaredOutputs = Array.isArray(taskState.agentConfig.outputFiles)
      ? taskState.agentConfig.outputFiles
      : [];
    for (const file of declaredOutputs) {
      if (typeof file === 'string' && file.trim().length > 0) {
        allFiles.add(file);
      }
    }

    for (const file of generatedPaths) {
      if (file.trim().length > 0) {
        allFiles.add(file);
      }
    }

    const outputFilesArray = Array.from(allFiles);
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

  private extractExecutionIdFromOutputs(
    outputs: Map<number, OutputFileInfo[]> | undefined,
  ): ExecutionId | undefined {
    if (!outputs) {
      return undefined;
    }

    for (const infos of outputs.values()) {
      for (const info of infos) {
        const candidate = this.resolveExecutionIdFromInfo(info);
        if (candidate) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  private resolveExecutionIdFromInfo(
    info: OutputFileInfo,
  ): ExecutionId | undefined {
    const relativeCandidates = [
      info.rawLocation?.runStorage?.storageRelativePath,
      info.location.runStorage?.storageRelativePath,
      info.originalLocation?.runStorage?.storageRelativePath,
      info.baseLocation?.runStorage?.storageRelativePath,
      info.prevLocation?.runStorage?.storageRelativePath,
    ];

    for (const relative of relativeCandidates) {
      const candidate = this.extractExecutionIdFromRelative(relative);
      if (candidate) {
        return candidate;
      }
    }

    return undefined;
  }

  private extractExecutionIdFromRelative(
    relative: string | null | undefined,
  ): ExecutionId | undefined {
    if (!relative) {
      return undefined;
    }

    const segments = relative.split(path.sep).filter(Boolean);
    const runsIndex = segments.indexOf('taskRuns');
    if (runsIndex === -1) {
      return undefined;
    }

    if (runsIndex + 1 >= segments.length) {
      return undefined;
    }

    const candidate = segments[runsIndex + 1];
    const normalizedCandidate = normalizeExecutionId(candidate);

    if (normalizedCandidate) {
      return normalizedCandidate;
    }

    return undefined;
  }

  private findPreferredOutputDirectory(
    outputs: Map<number, OutputFileInfo[]>,
  ): string | undefined {
    for (const infos of outputs.values()) {
      for (const info of infos) {
        const runStoragePath =
          info.rawLocation?.runStorage?.absolutePath ??
          info.location.runStorage?.absolutePath ??
          info.originalLocation?.runStorage?.absolutePath ??
          info.baseLocation?.runStorage?.absolutePath ??
          info.prevLocation?.runStorage?.absolutePath;

        if (runStoragePath) {
          return path.dirname(runStoragePath);
        }

        const workspacePath =
          info.rawLocation?.workspace?.absolutePath ??
          info.workspacePath ??
          info.location.workspace?.absolutePath ??
          info.original ??
          (path.isAbsolute(info.path) ? info.path : undefined);

        if (workspacePath) {
          return path.dirname(workspacePath);
        }
      }
    }

    return undefined;
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
