// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { ProgressViewProvider } from './ProgressViewProvider';

// Local imports - utils
import { safeExecuteCommand } from '../utils/commandUtils';

import { taskStateToAgentConfig } from '../utils/configConversion';

// @ts-ignore - Import JavaScript module
import { COMMANDS } from './modules/constants.js';

const CHANNEL = 'MessageHandler';

export class ProgressViewMessageHandler {
  private handlers: Record<
    string,
    (message: any, webviewView: vscode.WebviewView) => Promise<void> | void
  >;

  constructor(private readonly provider: ProgressViewProvider) {
    this.handlers = {
      [COMMANDS.SWITCH_STREAM]: (m) => this.provider.setActiveStream(m.stream),
      [COMMANDS.ERASE_STREAM]: (m) => this.provider.eraseStream(m.stream),
      [COMMANDS.DELETE_STREAM]: (m) => this.provider.deleteStream(m.stream),
      [COMMANDS.DELETE_ALL]: () => this.provider.deleteAllStreams(),
      [COMMANDS.STOP_STREAM]: (m) =>
        safeExecuteCommand('texra.stopAgent', [m.stream], CHANNEL),
      [COMMANDS.DIFF_STREAM]: (m) => this.handleDiffStream(m.stream),
      [COMMANDS.PACK_STREAM]: (m) => this.handlePackStream(m.stream),
      [COMMANDS.CLEAN_STREAM]: (m) => this.handleCleanStream(m.stream),
      [COMMANDS.RUN_AGAIN]: (m) => this.handleRunAgain(m.stream),
      [COMMANDS.RESTORE_STATE]: (m) => this.handleRestoreState(m.stream),
      [COMMANDS.OPEN_FILE]: (m) =>
        safeExecuteCommand('texra.openFileCompile', [m.file], CHANNEL),
      [COMMANDS.COMPARE_ORIGINAL]: (m) =>
        safeExecuteCommand(
          'texra.compare',
          [undefined, m.base, m.file],
          CHANNEL,
        ),
      [COMMANDS.COMPARE_PREVIOUS]: (m) =>
        safeExecuteCommand(
          'texra.compare',
          [undefined, m.prev, m.file],
          CHANNEL,
        ),
      [COMMANDS.ACCEPT_FILE]: (m) =>
        safeExecuteCommand(
          'texra.acceptEdited',
          [undefined, m.base, m.file],
          CHANNEL,
        ),
      [COMMANDS.MERGE_FILE]: (m) =>
        safeExecuteCommand('texra.merge', [undefined, m.base, m.file], CHANNEL),
      [COMMANDS.LATEXDIFF_FILE]: (m) =>
        safeExecuteCommand(
          'texra.latexdiff',
          [undefined, m.base, m.file],
          CHANNEL,
        ),
    };
  }

  async handleMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    logger.debug(CHANNEL, `Received message: ${message.command}`);

    const handler = this.handlers[message.command];
    if (handler) {
      await handler(message, webviewView);
    } else {
      logger.warn(CHANNEL, `Unknown command: ${message.command}`);
    }
  }

  private async handlePackStream(stream: string) {
    logger.debug(CHANNEL, `Attempting to pack stream with ID: ${stream}`);
    const taskState = this.provider.getTaskState(stream);
    if (!taskState) {
      logger.warn(CHANNEL, `No taskState found for stream: ${stream}`);
      return;
    }
    logger.debug(CHANNEL, `Found taskState for stream: ${stream}`);
    logger.debug(CHANNEL, `Task state: ${JSON.stringify(taskState)}`);

    // Execute pack command with taskState
    await safeExecuteCommand(
      'texra.pack',
      [
        {
          agent: taskState.agent,
          model: taskState.model,
          inputFile: taskState.inputFile,
          outputNameOverride: taskState.outputNameOverride,
          outputFiles: taskState.outputFiles,
          outputFilesActive: taskState.activeFiles.output,
        },
      ],
      CHANNEL,
    );
  }

  private async handleRunAgain(stream: string) {
    logger.debug(CHANNEL, `Attempting to re-run stream with ID: ${stream}`);
    const taskState = this.provider.getTaskState(stream);
    if (!taskState) {
      logger.warn(CHANNEL, `No taskState found for stream: ${stream}`);
      return;
    }
    logger.debug(CHANNEL, `Found taskState for stream: ${stream}`);
    logger.debug(CHANNEL, `Task state: ${JSON.stringify(taskState)}`);

    // Convert TaskState to AgentConfig using utility function
    const agentConfig = taskStateToAgentConfig(taskState);

    // Execute the agent with the restored config
    await safeExecuteCommand('texra.execute', [agentConfig], CHANNEL);
  }

  private async handleCleanStream(stream: string) {
    logger.debug(CHANNEL, `Attempting to clean stream with ID: ${stream}`);
    const taskState = this.provider.getTaskState(stream);
    if (!taskState) {
      logger.warn(CHANNEL, `No taskState found for stream: ${stream}`);
      return;
    }
    logger.debug(CHANNEL, `Found taskState for stream: ${stream}`);
    logger.debug(CHANNEL, `Task state: ${JSON.stringify(taskState)}`);

    // Execute clean command with taskState
    await safeExecuteCommand(
      'texra.clean',
      [
        {
          agent: taskState.agent,
          model: taskState.model,
          inputFile: taskState.inputFile,
          outputNameOverride: taskState.outputNameOverride,
          outputFiles: taskState.outputFiles,
          outputFilesActive: taskState.activeFiles.output,
        },
      ],
      CHANNEL,
    );
  }

  private async handleRestoreState(stream: string) {
    logger.debug(
      CHANNEL,
      `Attempting to restore state from stream with ID: ${stream}`,
    );
    const taskState = this.provider.getTaskState(stream);
    if (!taskState) {
      logger.warn(CHANNEL, `No taskState found for stream: ${stream}`);
      return;
    }
    logger.debug(CHANNEL, `Found taskState for stream: ${stream}`);
    logger.debug(CHANNEL, `Task state: ${JSON.stringify(taskState)}`);

    // Execute the restore state command with the task configuration
    await safeExecuteCommand('texra.restoreState', [taskState], CHANNEL);
  }

  private async handleDiffStream(stream: string) {
    logger.debug(
      CHANNEL,
      `Attempting to run latexdiff for stream with ID: ${stream}`,
    );
    const taskState = this.provider.getTaskState(stream);
    if (!taskState) {
      logger.warn(CHANNEL, `No taskState found for stream: ${stream}`);
      return;
    }
    logger.debug(CHANNEL, `Found taskState for stream: ${stream}`);
    logger.debug(CHANNEL, `Task state: ${JSON.stringify(taskState)}`);

    // Execute the latexdiff command with the task configuration
    await safeExecuteCommand(
      'texra.runLatexdiff',
      [
        {
          agent: taskState.agent,
          model: taskState.model,
          inputFile: taskState.inputFile,
          outputNameOverride: taskState.outputNameOverride,
          outputFiles: taskState.outputFiles,
          outputFilesActive: taskState.activeFiles.output,
        },
      ],
      CHANNEL,
    );
  }
}
