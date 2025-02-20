// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from './logUtils';
import { LogViewProvider } from './LogViewProvider';

const CHANNEL = 'MessageHandler';

export class LogViewMessageHandler {
  constructor(private readonly provider: LogViewProvider) {}

  async handleMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    logger.debug(CHANNEL, `Received message: ${message.command}`);

    switch (message.command) {
      case 'switchStream':
        this.provider.setActiveStream(message.stream);
        break;
      case 'clearStream':
        this.provider.clearStream(message.stream);
        break;
      case 'deleteStream':
        this.provider.deleteStream(message.stream);
        break;
      case 'deleteAll':
        this.provider.deleteAllStreams();
        break;
      case 'stopStream':
        vscode.commands.executeCommand('coauthor.stopAgent', message.stream);
        break;
      case 'packStream':
        await this.handlePackStream(message.stream);
        break;
      case 'cleanStream':
        await this.handleCleanStream(message.stream);
        break;
      default:
        logger.warn(CHANNEL, `Unknown command: ${message.command}`);
    }
  }

  private async handlePackStream(stream: string) {
    logger.debug(CHANNEL, `Attempting to pack stream with ID: ${stream}`);
    const taskState = this.provider.getTaskState(stream);
    if (!taskState) {
      logger.warn(CHANNEL, `No task state found for stream: ${stream}`);
      return;
    }
    logger.debug(CHANNEL, `Found task state for stream: ${stream}`);
    logger.debug(CHANNEL, `Task state: ${JSON.stringify(taskState)}`);

    // Execute pack command with task state
    await vscode.commands.executeCommand('coauthor.pack', {
      agent: taskState.agent,
      model: taskState.model,
      inputFile: taskState.inputFile,
      outputNameOverride: taskState.outputNameOverride,
      multipleOutputFiles: taskState.multipleOutputFiles,
      multipleOutputFilesVisible: taskState.multipleOutputFilesVisible,
    });
  }

  private async handleCleanStream(stream: string) {
    logger.debug(CHANNEL, `Attempting to clean stream with ID: ${stream}`);
    const taskState = this.provider.getTaskState(stream);
    if (!taskState) {
      logger.warn(CHANNEL, `No task state found for stream: ${stream}`);
      return;
    }
    logger.debug(CHANNEL, `Found task state for stream: ${stream}`);
    logger.debug(CHANNEL, `Task state: ${JSON.stringify(taskState)}`);

    // Execute clean command with task state
    await vscode.commands.executeCommand('coauthor.clean', {
      agent: taskState.agent,
      model: taskState.model,
      inputFile: taskState.inputFile,
      outputNameOverride: taskState.outputNameOverride,
      multipleOutputFiles: taskState.multipleOutputFiles,
      multipleOutputFilesVisible: taskState.multipleOutputFilesVisible,
    });
  }
}
