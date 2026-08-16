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
import { createLog } from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type {
  FileOperationMessage,
  MainViewExecuteMessage,
  MainViewInboundMessage,
} from '@shared/schemas';
import { pathToLocation } from '@utils/files/fileLocation';

const CHANNEL = 'ExecutionHandlers';
const log = createLog(CHANNEL);

type MessageFor<C extends MainViewInboundMessage['command']> = Extract<
  MainViewInboundMessage,
  { command: C }
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
      void vscode.commands.executeCommand(
        `texra.${message.command}`,
        pathToLocation(message.baseFile),
        pathToLocation(message.baseFile),
        pathToLocation(message.editedFile),
      );
      return;
  }
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
  log.info(
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
