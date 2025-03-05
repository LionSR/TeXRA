// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from './logUtils';
import { LogViewProvider } from './LogViewProvider';
// @ts-ignore - Import JavaScript module
import { COMMANDS } from './logView/modules/constants.js';
import { taskStateToAgentConfig } from '../utils/configConversion';

const CHANNEL = 'MessageHandler';

export class LogViewMessageHandler {
  constructor(private readonly provider: LogViewProvider) {}

  async handleMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    logger.debug(CHANNEL, `Received message: ${message.command}`);

    switch (message.command) {
      case COMMANDS.SWITCH_STREAM:
        this.provider.setActiveStream(message.stream);
        break;
      case COMMANDS.ERASE_STREAM:
        this.provider.eraseStream(message.stream);
        break;
      case COMMANDS.DELETE_STREAM:
        this.provider.deleteStream(message.stream);
        break;
      case COMMANDS.DELETE_ALL:
        this.provider.deleteAllStreams();
        break;
      case COMMANDS.STOP_STREAM:
        vscode.commands.executeCommand('coauthor.stopAgent', message.stream);
        break;
      case COMMANDS.DIFF_STREAM:
        await this.handleDiffStream(message.stream);
        break;
      case COMMANDS.PACK_STREAM:
        await this.handlePackStream(message.stream);
        break;
      case COMMANDS.CLEAN_STREAM:
        await this.handleCleanStream(message.stream);
        break;
      case COMMANDS.RUN_AGAIN:
        await this.handleRunAgain(message.stream);
        break;
      case COMMANDS.RESTORE_STATE:
        await this.handleRestoreState(message.stream);
        break;
      default:
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
    await vscode.commands.executeCommand('coauthor.pack', {
      agent: taskState.agent,
      model: taskState.model,
      inputFile: taskState.inputFile,
      outputNameOverride: taskState.outputNameOverride,
      multipleOutputFiles: taskState.multipleOutputFiles,
      multipleOutputFilesVisible: taskState.multipleOutputFilesVisible,
    });
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
    await vscode.commands.executeCommand('coauthor.execute', agentConfig);
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
    await vscode.commands.executeCommand('coauthor.clean', {
      agent: taskState.agent,
      model: taskState.model,
      inputFile: taskState.inputFile,
      outputNameOverride: taskState.outputNameOverride,
      multipleOutputFiles: taskState.multipleOutputFiles,
      multipleOutputFilesVisible: taskState.multipleOutputFilesVisible,
    });
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
    await vscode.commands.executeCommand('coauthor.restoreState', taskState);
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
    await vscode.commands.executeCommand('coauthor.runLatexdiff', {
      agent: taskState.agent,
      model: taskState.model,
      inputFile: taskState.inputFile,
      outputNameOverride: taskState.outputNameOverride,
      multipleOutputFiles: taskState.multipleOutputFiles,
      multipleOutputFilesVisible: taskState.multipleOutputFilesVisible,
    });
  }
}
