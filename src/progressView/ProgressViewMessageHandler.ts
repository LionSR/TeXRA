// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { ProgressViewProvider } from './ProgressViewProvider';
import {
  BaseViewMessageHandler,
  MessageHandler,
} from '@common/webview/BaseViewMessageHandler';
// Local imports - agent types
import {
  AgentTypeFilter,
  isAgentTypeFilter,
} from '@agent/types/AgentStreamTypes';
import {
  isWorkflowTaskState,
  type WorkflowTaskState,
  type TaskState,
} from '@logger/TaskState';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
// Local imports - storage
import { ensureRunDir, getRunDir } from '@utils/files/taskRunStorage';
// Local imports - commands
import { safeExecuteCommand } from '@utils/system/commandUtils';
import { RecordingManager } from '@webview/managers/RecordingManager';
import {
  buildFileContextFromTaskState,
  polishTextWithAI,
} from '@utils/text/textEnhancementUtils';
import { bus } from '@eventBus/ProgressEventBus';

// @ts-ignore - Import JavaScript module
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

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
    super('ProgressView');
    this.recordingManager = new RecordingManager(context, {
      recordingStartedCommand: PROGRESS_VIEW_COMMANDS.RECORDING_STARTED,
      recordingErrorCommand: PROGRESS_VIEW_COMMANDS.RECORDING_ERROR,
      transcriptionCommand: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED,
      progressTitle: 'Transcribing follow-up message',
    });
  }

  private async deleteSessionSnapshot(stream: StreamTabId): Promise<void> {
    const executionId = this.provider.state.getExecutionId(stream);
    if (executionId) {
      const { ToolUseSessionManager } = await import(
        '@agent/toolUse/ToolUseSessionManager'
      );
      await ToolUseSessionManager.deleteSnapshot(executionId);
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
      [PROGRESS_VIEW_COMMANDS.ERASE_STREAM]: this.handleEraseStream.bind(this),
      [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: this.handleDeleteAll.bind(this),
      [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: this.handleStopStream.bind(this),

      // Actions
      [PROGRESS_VIEW_COMMANDS.RUN_AGAIN]: this.handleRunAgain.bind(this),
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
  protected override async handleWebviewReady(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.provider.markWebviewReady();
  }

  private async handleSwitchStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.provider.setActiveStream(message.stream);
  }

  private async handleDeleteStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    // Delete persisted session data if any
    await this.deleteSessionSnapshot(message.stream);
    this.provider.state.clearStream(message.stream);
    this.provider.updateWebview();
  }

  private async handleEraseStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    // Delete persisted session data when erasing stream
    await this.deleteSessionSnapshot(message.stream);
    this.provider.state.eraseStreamContent(message.stream);
    this.provider.updateWebview();
  }

  private async handleDeleteAll(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    // Delete all persisted session data
    const allStates = this.provider.state.getAllTaskStates();
    for (const [stream] of allStates) {
      await this.deleteSessionSnapshot(stream);
    }

    this.provider.state.clearAll();
    this.provider.updateWebview();
  }

  private async handleStopStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.stopAgent', message.stream);
  }

  private async handleRunAgain(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      await vscode.commands.executeCommand(
        'texra.execute',
        taskState.agentConfig,
      );
    });
  }

  private async handleDiffStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      await vscode.commands.executeCommand('texra.runLatexdiff', {
        agent: taskState.agentConfig.agent,
        model: taskState.agentConfig.model,
        inputFile: taskState.agentConfig.inputFile,
        outputFiles: taskState.agentConfig.outputFiles,
        outputFilesActive: taskState.activeFiles.output,
      });
    });
  }

  private async handlePackStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      await this.handleFileOperation(message.stream, taskState, 'texra.pack');
    });
  }

  private async handleCleanStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.withToolbarTaskState(message.stream, async (taskState) => {
      await this.handleFileOperation(message.stream, taskState, 'texra.clean');
    });
  }

  private async handleSortStreams(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.provider.state.streamSortOrder = message.sortBy ?? 'time';
    this.provider.updateWebview();
  }

  private async handleFilterStreams(
    message: any,
    _webviewView: vscode.WebviewView,
  ): Promise<void> {
    const requestedFilter = message.filter;
    const filter: AgentTypeFilter = isAgentTypeFilter(requestedFilter)
      ? requestedFilter
      : 'all';
    this.provider.state.agentTypeFilter = filter;
    this.provider.updateWebview();
  }

  private async handleRestoreState(
    message: any,
    _webviewView: vscode.WebviewView,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(message.stream);
    if (taskState) {
      bus.emit('restoreStateRequest', {
        taskState,
        streamId: message.stream,
        source: 'progressView',
      });
    }
  }

  private async handleSendFollowUp(
    message: any,
    _webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.sendFollowUp', {
      stream: message.stream,
      text: message.text,
    });
  }

  private async handlePolishFollowUp(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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
            webviewView.webview.postMessage({
              command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED,
              text: result.text,
            });
          } else if (result.error) {
            await vscode.window.showErrorMessage(result.error);
          }
        } catch (error) {
          const messageText =
            error instanceof Error ? error.message : 'Unknown error';
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

  private async handleOpenTaskStorage(
    message: any,
    _webviewView: vscode.WebviewView,
  ): Promise<void> {
    const stream = message.stream as StreamTabId | undefined;
    if (!stream) {
      await vscode.window.showInformationMessage(
        'No workspace storage folder is available for this run yet.',
      );
      return;
    }

    const executionId = this.provider.state.getExecutionId(stream);
    if (!executionId) {
      await vscode.window.showInformationMessage(
        'No workspace storage folder is available for this run yet.',
      );
      return;
    }

    try {
      await ensureRunDir(executionId);
      const runDir = getRunDir(executionId);
      await safeExecuteCommand('revealFileInOS', [vscode.Uri.file(runDir)]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        this.channel,
        `Failed to open task storage for stream ${stream}, executionId ${executionId}: ${errorMessage}`,
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

  private async handleOpenFile(
    message: FileCommandMessage,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openFile', message.file);
  }

  private async handleOpenFileCompile(
    message: FileCommandMessage,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openFileCompile', message.file);
  }

  private async handleCompareOriginal(
    message: BaseFileCommandMessage,
    webviewView: vscode.WebviewView,
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

  private async handleComparePrevious(
    message: CompareMessage,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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
    webviewView: vscode.WebviewView,
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
    webviewView: vscode.WebviewView,
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
    webviewView: vscode.WebviewView,
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

  private async handleOpenLabel(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openLabel', message.label);
  }

  private async handleFileOperation(
    stream: string,
    taskState: WorkflowTaskState,
    command: 'texra.pack' | 'texra.clean',
  ): Promise<void> {
    const generated = this.provider.state.outputFiles.getFiles(stream);
    const allFiles = new Set<string>(taskState.agentConfig.outputFiles || []);
    if (generated) {
      for (const [round, infos] of Object.entries(generated)) {
        if (!Array.isArray(infos)) {
          this.logger.warn(
            `Skipping invalid output metadata for stream ${stream}, round ${round}`,
          );
          continue;
        }

        for (const info of infos) {
          allFiles.add(info.path);
          if (info.original) {
            allFiles.add(info.original);
          }
        }
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
