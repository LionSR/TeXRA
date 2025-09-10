// Third-party imports
import type * as vscode from 'vscode';

// Local imports - progress view
import type { ProgressViewProvider } from './ProgressViewProvider';
import {
  BaseViewMessageHandler,
  MessageHandler,
} from '@common/webview/BaseViewMessageHandler';

// @ts-ignore - Import JavaScript module
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { safeExecuteCommand } from '@utils/system';

export class ProgressViewMessageHandler extends BaseViewMessageHandler {
  constructor(private readonly provider: ProgressViewProvider) {
    super('ProgressView');
  }

  /**
   * Argument extractors for VS Code commands
   */
  private readonly argExtractors: Record<string, (m: any) => any[]> = {
    [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (m) => [m.stream],
    [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]: (m) => [
      { stream: m.stream, text: m.text },
    ],
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: (m) => [m.file],
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: (m) => [m.file],
    [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: (m) => [
      undefined,
      m.base,
      m.file,
    ],
    [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: (m) => [
      undefined,
      m.prev,
      m.file,
    ],
    [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: (m) => [undefined, m.base, m.file],
    [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: (m) => [undefined, m.base, m.file],
    [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: (m) => [undefined, m.base, m.file],
    [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: (m) => [m.label],
  };

  /**
   * Get command map - lazy initialization to avoid initialization order issues
   * @returns Map of webview commands to VS Code commands or state mutators
   */
  private getCommandMap(): Record<
    string,
    string | ((message: any) => Promise<boolean> | boolean)
  > {
    return {
      // Stream management - state mutators
      [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (m) => {
        this.provider.setActiveStream(m.stream);
        return false; // setActiveStream already calls updateWebview
      },
      [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (m) => {
        this.provider.state.clearStream(m.stream);
        return true;
      },
      [PROGRESS_VIEW_COMMANDS.ERASE_STREAM]: (m) => {
        this.provider.state.eraseStreamContent(m.stream);
        return true;
      },
      [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => {
        this.provider.state.clearAll();
        return true;
      },
      [PROGRESS_VIEW_COMMANDS.SORT_STREAMS]: (m) => {
        this.provider.state.streamSortOrder = m.sortBy ?? 'time';
        return true;
      },

      // Stream management - VS Code commands
      [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: 'texra.stopAgent',

      // Actions requiring additional logic
      [PROGRESS_VIEW_COMMANDS.RUN_AGAIN]: async (m) => {
        const taskState = this.provider.state.getTaskState(m.stream);
        if (taskState) {
          await safeExecuteCommand(
            'texra.execute',
            [taskState.agentConfig],
            this.viewName,
          );
        }
        return false;
      },
      [PROGRESS_VIEW_COMMANDS.DIFF_STREAM]: async (m) => {
        const taskState = this.provider.state.getTaskState(m.stream);
        if (taskState) {
          await safeExecuteCommand(
            'texra.runLatexdiff',
            [
              {
                agent: taskState.agentConfig.agent,
                model: taskState.agentConfig.model,
                inputFile: taskState.agentConfig.inputFile,
                outputFiles: taskState.agentConfig.outputFiles,
                outputFilesActive: taskState.activeFiles.output,
              },
            ],
            this.viewName,
          );
        }
        return false;
      },
      [PROGRESS_VIEW_COMMANDS.PACK_STREAM]: async (m) => {
        await this.handleFileOperation(m.stream, 'texra.pack');
        return false;
      },
      [PROGRESS_VIEW_COMMANDS.CLEAN_STREAM]: async (m) => {
        await this.handleFileOperation(m.stream, 'texra.clean');
        return false;
      },
      [PROGRESS_VIEW_COMMANDS.RESTORE_STATE]: async (m) => {
        const taskState = this.provider.state.getTaskState(m.stream);
        if (taskState) {
          await safeExecuteCommand(
            'texra.restoreState',
            [taskState],
            this.viewName,
          );
        }
        return false;
      },

      // Simple VS Code command mappings
      [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]: 'texra.sendFollowUp',
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: 'texra.openFile',
      [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: 'texra.openFileCompile',
      [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: 'texra.compare',
      [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: 'texra.compare',
      [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: 'texra.acceptEdited',
      [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: 'texra.merge',
      [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: 'texra.latexdiff',
      [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: 'texra.openLabel',
    };
  }

  protected createHandlers(): Record<string, MessageHandler> {
    const commandMap = this.getCommandMap();
    const dispatch = this.dispatchCommand.bind(this);
    const handlers: Record<string, MessageHandler> = {
      // Common handlers
      [PROGRESS_VIEW_COMMANDS.THEME_SET]: this.handleTheme.bind(this),
      [PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET]: this.handleDebugMode.bind(this),
      [PROGRESS_VIEW_COMMANDS.WEBVIEW_READY]:
        this.handleWebviewReady.bind(this),
    };

    for (const command of Object.keys(commandMap)) {
      handlers[command] = (m, w) => dispatch(command, m, w);
    }

    return handlers;
  }

  private async dispatchCommand(
    command: string,
    message: any,
    _webviewView: vscode.WebviewView,
  ): Promise<void> {
    const commandMap = this.getCommandMap();
    const mapping = commandMap[command];
    if (!mapping) {
      return;
    }

    if (typeof mapping === 'string') {
      const args = this.argExtractors[command]
        ? this.argExtractors[command](message)
        : [];
      await safeExecuteCommand(mapping, args, this.viewName);
      return;
    }

    const stateChanged = await mapping(message);
    if (stateChanged) {
      this.provider.updateWebview();
    }
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
    const outputActive = taskState.activeFiles.output;
    await safeExecuteCommand(
      command,
      [
        {
          streamId: stream,
          agent: taskState.agentConfig.agent,
          model: taskState.agentConfig.model,
          inputFile: taskState.agentConfig.inputFile,
          outputFiles: outputActive ? outputFilesArray : [],
          activeFiles: {
            output: outputActive,
          },
        },
      ],
      this.viewName,
    );
  }
}
