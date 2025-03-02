// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from './logUtils';
import { LogViewProvider } from './LogViewProvider';
// @ts-ignore - Import JavaScript module
import { COMMANDS } from './logView/modules/constants.js';

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

    // Convert taskState to agentConfig
    const agentConfig = {
      agent: taskState.agent,
      model: taskState.model,
      instruction: taskState.instruction,
      inputFile: taskState.inputFile,
      referenceFile: taskState.referenceFile || undefined,
      auxiliaryFile: taskState.auxiliaryFile || undefined,
      figureFile: taskState.figureFile || undefined,
      outputNameOverride: taskState.outputNameOverride || undefined,
      inputFiles: taskState.multipleInputFilesVisible
        ? taskState.multipleInputFiles
        : [],
      referenceFiles: taskState.multipleReferenceFilesVisible
        ? taskState.multipleReferenceFiles
        : [],
      auxiliaryFiles: taskState.multipleAuxiliaryFilesVisible
        ? taskState.multipleAuxiliaryFiles
        : [],
      figureFiles: taskState.multipleFigureFilesVisible
        ? taskState.multipleFigureFiles
        : [],
      outputFiles: taskState.multipleOutputFilesVisible
        ? taskState.multipleOutputFiles
        : [],
      toolConfig: {
        autoExtractFigure: taskState.autoExtractFigure,
        autoExtractTikzFigure: taskState.autoExtractTikzFigure,
        attachTeXCount: taskState.attachTeXCount,
        usePrefillFromInput: taskState.usePrefillFromInput,
        printInputPrompt: taskState.printInputPrompt,
        reflect: taskState.reflect,
      },
    };

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
}
