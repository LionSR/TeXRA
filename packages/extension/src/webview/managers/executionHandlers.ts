import * as path from 'node:path';

import * as vscode from 'vscode';

import { AUTH_COMMANDS } from '@auth/constants';
import {
  formatUnavailableTeamMembersMessage,
  TEAM_LAUNCH_CANCEL_LABEL,
  TEAM_LAUNCH_CONTINUE_LABEL,
  TEAM_LAUNCH_SIGN_IN_LABEL,
} from '@common/teams/TeamPlan';
import { prepareMainViewExecutionLaunch } from '@controllers/mainView/backend/MainViewExecutionLaunchController';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import type {
  FileOperationMessage,
  MainViewInboundMessage,
} from '@shared/schemas/mainView/inbound';
import { pathToLocation } from '@utils/files/fileLocation';

const CHANNEL = 'ExecutionHandlers';

type MessageFor<C extends MainViewInboundMessage['command']> = Extract<
  MainViewInboundMessage,
  { command: C }
>;

/** Housekeeping commands take no payload beyond the command itself. */
type HousekeepingMessage = MessageFor<
  | typeof MAIN_VIEW_COMMANDS.CLEAN_OUTPUT
  | typeof MAIN_VIEW_COMMANDS.CLEAN_BUILD
  | typeof MAIN_VIEW_COMMANDS.INDENT_TEX
>;

/** Single-file pack/clean commands: the file plus the agent/model to run it with. */
type SingleOperationMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.PACK_SINGLE | typeof MAIN_VIEW_COMMANDS.CLEAN_SINGLE
>;

/** Multi-file pack/clean commands: same as single-file, plus the extra file batch. */
type MultipleOperationMessage = MessageFor<
  | typeof MAIN_VIEW_COMMANDS.PACK_MULTIPLE
  | typeof MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE
>;

export async function handleExecute(
  message: MainViewExecuteMessage,
): Promise<void> {
  const requestedWorkingDirectory = message.session?.workingDirectory?.trim();
  if (
    requestedWorkingDirectory &&
    !vscode.workspace.workspaceFolders?.some(
      (folder) =>
        path.resolve(folder.uri.fsPath) ===
        path.resolve(requestedWorkingDirectory),
    )
  ) {
    vscode.window.showErrorMessage(
      'Choose one of the open workspace folders as the working directory.',
    );
    return;
  }

  const launch = await prepareMainViewExecutionLaunch(message, {
    chooseTeamAvailability: async (unavailableNames) => {
      const choice = await vscode.window.showWarningMessage(
        formatUnavailableTeamMembersMessage(unavailableNames),
        TEAM_LAUNCH_SIGN_IN_LABEL,
        TEAM_LAUNCH_CONTINUE_LABEL,
        TEAM_LAUNCH_CANCEL_LABEL,
      );
      if (choice === TEAM_LAUNCH_SIGN_IN_LABEL) return 'sign-in';
      if (choice === TEAM_LAUNCH_CONTINUE_LABEL) return 'continue';
      return 'cancel';
    },
    signInForRemoteAgentCatalog: async () =>
      Boolean(
        await vscode.commands.executeCommand<boolean>(AUTH_COMMANDS.SIGN_IN),
      ),
  });
  if (launch.status === 'cancelled') return;
  if (launch.status === 'error') {
    await vscode.window.showErrorMessage(launch.message);
    return;
  }
  if (launch.infoMessage) {
    await vscode.window.showInformationMessage(launch.infoMessage);
  }
  const { preparation } = launch;
  if (!preparation.valid) {
    logErrorMessage(
      CHANNEL,
      'AgentConfig validation failed',
      preparation.message,
    );
    if (preparation.docsCommand) {
      const openDocs = 'Open file management guide';
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
  switch (message.command) {
    case MAIN_VIEW_COMMANDS.MERGE:
      void vscode.commands.executeCommand(
        `texra.${message.command}`,
        message.inputFile,
        undefined,
        message.editedFile,
      );
      return;
    case MAIN_VIEW_COMMANDS.COMPARE:
    case MAIN_VIEW_COMMANDS.ACCEPT_EDITED:
      // The base file is passed in both the "compare against" and "replace"
      // slots; resolve it once.
      const baseLocation = pathToLocation(message.baseFile);
      void vscode.commands.executeCommand(
        `texra.${message.command}`,
        baseLocation,
        baseLocation,
        pathToLocation(message.editedFile),
      );
      return;
  }
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
