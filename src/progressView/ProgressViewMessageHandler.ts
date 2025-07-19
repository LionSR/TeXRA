import * as vscode from 'vscode';
import {
  BaseViewMessageHandler,
  MessageHandler,
} from '@common/webview/BaseViewMessageHandler';
import type { ProgressViewProvider } from './ProgressViewProvider';
// @ts-ignore - Import JavaScript module
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

export class ProgressViewMessageHandler extends BaseViewMessageHandler {
  constructor(private readonly provider: ProgressViewProvider) {
    super('ProgressView');
  }

  protected createHandlers(): Record<string, MessageHandler> {
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
      [PROGRESS_VIEW_COMMANDS.RESTORE_STATE]:
        this.handleRestoreState.bind(this),

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
    this.provider.state.clearStream(message.stream);
    this.provider.updateWebview();
  }

  private async handleEraseStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.provider.state.eraseStreamContent(message.stream);
    this.provider.updateWebview();
  }

  private async handleDeleteAll(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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
    const taskState = this.provider.state.getTaskState(message.stream);
    if (taskState) {
      await vscode.commands.executeCommand(
        'texra.execute',
        taskState.agentConfig,
      );
    }
  }

  private async handleDiffStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(message.stream);
    if (taskState) {
      await vscode.commands.executeCommand('texra.runLatexdiff', {
        agent: taskState.agentConfig.agent,
        model: taskState.agentConfig.model,
        inputFile: taskState.agentConfig.inputFile,
        outputFiles: taskState.agentConfig.outputFiles,
        outputFilesActive: taskState.activeFiles.output,
      });
    }
  }

  private async handlePackStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.handleFileOperation(message.stream, 'texra.pack');
  }

  private async handleCleanStream(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await this.handleFileOperation(message.stream, 'texra.clean');
  }

  private async handleRestoreState(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(message.stream);
    if (taskState) {
      await vscode.commands.executeCommand('texra.restoreState', taskState);
    }
  }

  private async handleOpenFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openFile', message.file);
  }

  private async handleOpenFileCompile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.openFileCompile', message.file);
  }

  private async handleCompareOriginal(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand(
      'texra.compare',
      undefined,
      message.base,
      message.file,
    );
  }

  private async handleComparePrevious(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand(
      'texra.compare',
      undefined,
      message.prev,
      message.file,
    );
  }

  private async handleAcceptFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand(
      'texra.acceptEdited',
      undefined,
      message.base,
      message.file,
    );
  }

  private async handleMergeFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    await vscode.commands.executeCommand(
      'texra.merge',
      undefined,
      message.base,
      message.file,
    );
  }

  private async handleLatexdiffFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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
    command: 'texra.pack' | 'texra.clean',
  ): Promise<void> {
    const taskState = this.provider.state.getTaskState(stream);
    if (!taskState) return;

    const generated = this.provider.state.outputFiles.getFiles(stream);
    const allFiles = new Set<string>(taskState.agentConfig.outputFiles || []);
    if (generated) {
      Object.values(generated).forEach((infos: any) =>
        infos.forEach((info: any) => {
          allFiles.add(info.path);
          if (info.original) {
            allFiles.add(info.original);
          }
        }),
      );
    }

    const outputFilesArray = Array.from(allFiles);
    await vscode.commands.executeCommand(command, {
      streamId: stream,
      agent: taskState.agentConfig.agent,
      model: taskState.agentConfig.model,
      inputFile: taskState.agentConfig.inputFile,
      outputFiles: outputFilesArray,
      activeFiles: {
        output: outputFilesArray.length > 0,
      },
    });
  }
}
