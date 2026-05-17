import * as vscode from 'vscode';

import {
  prepareMainViewExecutionRequest,
  type MainViewExecuteMessage,
} from '@controllers/mainView/MainViewExecutionController';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ExecutionManager';
logger.initialize(CHANNEL);

/** Message shape for command-based operations. */
interface CommandMessage {
  command: string;
  inputFile?: string;
  baseFile?: string;
  editedFile?: string;
  agent?: string;
  model?: string;
  inputFiles?: string[];
  outputFiles?: string[];
}

export class ExecutionManager {
  async handleExecute(message: MainViewExecuteMessage): Promise<void> {
    const preparation = prepareMainViewExecutionRequest(message);
    if (!preparation.valid) {
      if (preparation.docsCommand) {
        const openDocs = 'File Management Guide';
        const choice = await vscode.window.showErrorMessage(
          preparation.message,
          openDocs,
        );
        if (choice === openDocs) {
          void vscode.commands.executeCommand(
            'texra.openDoc',
            preparation.docsCommand,
          );
        }
      } else {
        vscode.window.showErrorMessage(preparation.message);
      }
      logger.error(
        CHANNEL,
        `AgentConfig validation failed: ${preparation.message}`,
      );
      return;
    }

    await vscode.commands.executeCommand('texra.execute', preparation.request);
  }

  handleFileOperation(message: CommandMessage): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleHousekeeping(message: CommandMessage): void {
    void vscode.commands.executeCommand(`texra.${message.command}`);
  }

  handleSingleOperation(message: CommandMessage): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
    );
  }

  handleMultipleOperation(message: CommandMessage): void {
    const inputFiles = message.inputFiles ?? [];
    const label = message.command.startsWith('pack') ? 'Packing' : 'Cleaning';
    logger.info(
      CHANNEL,
      `${label} multiple files: ${message.inputFile}, ${inputFiles.join(', ')}`,
    );
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
      inputFiles,
    );
  }
}
