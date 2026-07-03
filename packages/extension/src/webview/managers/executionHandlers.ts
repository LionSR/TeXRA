import * as vscode from 'vscode';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import type { MainViewExecuteMessage } from '@shared/mainView';
import type { FileOperationMessage } from '@shared/schemas/mainView/inbound';

const CHANNEL = 'ExecutionHandlers';
logger.initialize(CHANNEL);

/** Message shape for command-based operations without a validated payload
 * schema (housekeeping/pack/clean commands). */
export interface CommandMessage {
  command: string;
  agent?: string;
  model?: string;
  inputFile?: string;
  inputFiles?: string[];
  outputFiles?: string[];
}

export async function handleExecute(
  message: MainViewExecuteMessage,
): Promise<void> {
  const preparation = prepareMainViewExecutionRequest(message);
  if (!preparation.valid) {
    logErrorMessage(
      CHANNEL,
      'AgentConfig validation failed',
      preparation.message,
    );
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
    return;
  }

  await vscode.commands.executeCommand('texra.execute', preparation.request);
}

export function handleFileOperation(message: FileOperationMessage): void {
  void vscode.commands.executeCommand(
    `texra.${message.command}`,
    'inputFile' in message ? message.inputFile : undefined,
    'baseFile' in message ? message.baseFile : undefined,
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
