import * as vscode from 'vscode';

import { AUTH_COMMANDS } from '@commands/auth';
import {
  formatPartialTeamLaunchMessage,
  formatTeamLaunchBlockedMessage,
  formatTeamUnavailableMessage,
  formatUnavailableTeamMembersMessage,
  formatUnknownTeamMessage,
  resolveTeamLaunch,
  TEAM_LAUNCH_CANCEL_LABEL,
  TEAM_LAUNCH_CONTINUE_LABEL,
  TEAM_LAUNCH_SIGN_IN_LABEL,
  TEAM_SELECTION_REQUIRED_MESSAGE,
} from '@common/teams/TeamPlan';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import {
  type MainViewExecutionPreparationResult,
  prepareMainViewExecutionRequest,
  prepareMainViewTeamExecutionRequest,
} from '@controllers/mainView/MainViewExecutionController';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import type { FileOperationMessage } from '@shared/schemas/mainView/inbound';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  let preparation: MainViewExecutionPreparationResult;
  if (message.session?.launchTarget === 'team') {
    try {
      const teamId = message.session.teamId;
      if (!teamId) {
        vscode.window.showErrorMessage(TEAM_SELECTION_REQUIRED_MESSAGE);
        return;
      }

      const resolution = await resolveTeamLaunch({
        teamId,
        ...createTeamCatalogPorts(),
        choose: async (unavailableNames) => {
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
        signIn: async () =>
          Boolean(
            await vscode.commands.executeCommand<boolean>(
              AUTH_COMMANDS.SIGN_IN,
            ),
          ),
      });

      if (resolution.status === 'cancelled') return;
      if (resolution.status === 'unknown-team') {
        vscode.window.showErrorMessage(formatUnknownTeamMessage(teamId));
        return;
      }
      if (resolution.status === 'blocked') {
        vscode.window.showErrorMessage(
          formatTeamLaunchBlockedMessage(teamId, resolution.reason),
        );
        return;
      }
      if (resolution.status === 'unavailable') {
        vscode.window.showErrorMessage(
          formatTeamUnavailableMessage(teamId, resolution.unavailableNames),
        );
        return;
      }

      if (resolution.partial) {
        await vscode.window.showInformationMessage(
          formatPartialTeamLaunchMessage(resolution.missingNames),
        );
      }
      preparation = prepareMainViewTeamExecutionRequest(
        message,
        resolution.fields,
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Team launch failed: ${toErrorMessage(error)}`,
      );
      return;
    }
  } else {
    preparation = prepareMainViewExecutionRequest(message);
  }
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
        undefined,
        message.baseFile,
        message.editedFile,
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
