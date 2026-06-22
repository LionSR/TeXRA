import * as vscode from 'vscode';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import * as logger from '@logger/logUtils';
import type { MainViewExecuteMessage } from '@shared/mainView';

const CHANNEL = 'ExecutionHandlers';
logger.initialize(CHANNEL);

/** Message shape for command-based operations. */
export interface CommandMessage {
  command: string;
  inputFile?: string;
  baseFile?: string;
  editedFile?: string;
  agent?: string;
  model?: string;
  inputFiles?: string[];
  outputFiles?: string[];
}

export async function handleExecute(
  message: MainViewExecuteMessage,
): Promise<void> {
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

export function handleFileOperation(message: CommandMessage): void {
  void vscode.commands.executeCommand(
    `texra.${message.command}`,
    message.inputFile,
    message.baseFile,
    message.editedFile,
  );
}

export function handleHousekeeping(message: CommandMessage): void {
  void vscode.commands.executeCommand(`texra.${message.command}`);
}

export function handleSingleOperation(message: CommandMessage): void {
  void vscode.commands.executeCommand(
    `texra.${message.command}`,
    message.inputFile,
    message.agent,
    message.model,
  );
}

export function handleMultipleOperation(message: CommandMessage): void {
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
