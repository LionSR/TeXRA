import * as vscode from 'vscode';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import type { FileOperationMessage } from '@shared/schemas/mainView/inbound';

const CHANNEL = 'ExecutionHandlers';

/** Housekeeping commands take no payload beyond the command itself. */
export interface HousekeepingMessage {
  command:
    | typeof MAIN_VIEW_COMMANDS.CLEAN_OUTPUT
    | typeof MAIN_VIEW_COMMANDS.CLEAN_BUILD
    | typeof MAIN_VIEW_COMMANDS.INDENT_TEX;
}

/** Single-file pack/clean commands: the file plus the agent/model to run it with. */
export interface SingleOperationMessage {
  command:
    | typeof MAIN_VIEW_COMMANDS.PACK_SINGLE
    | typeof MAIN_VIEW_COMMANDS.CLEAN_SINGLE;
  inputFile: string;
  agent: string;
  model: string;
}

/** Multi-file pack/clean commands: same as single-file, plus the extra file batch. */
export interface MultipleOperationMessage {
  command:
    | typeof MAIN_VIEW_COMMANDS.PACK_MULTIPLE
    | typeof MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE;
  inputFile: string;
  agent: string;
  model: string;
  inputFiles?: string[];
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

export function handleHousekeeping(message: HousekeepingMessage): void {
  void vscode.commands.executeCommand(`texra.${message.command}`);
}

export function handleSingleOperation(message: SingleOperationMessage): void {
  void vscode.commands.executeCommand(
    `texra.${message.command}`,
    message.inputFile,
    message.agent,
    message.model,
  );
}

export function handleMultipleOperation(
  message: MultipleOperationMessage,
): void {
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
