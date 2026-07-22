import * as vscode from 'vscode';

import { getAgentsByCategory, refresh } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import { AUTH_COMMANDS } from '@commands/auth';
import { resolveTeamLaunch } from '@common/teams/TeamPlan';
import {
  prepareMainViewExecutionRequest,
  prepareMainViewTeamExecutionRequest,
} from '@controllers/mainView/MainViewExecutionController';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import type { FileOperationMessage } from '@shared/schemas/mainView/inbound';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

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
  let preparation;
  if (message.session?.launchTarget === 'team') {
    const teamId = message.session.teamId;
    if (!teamId) {
      vscode.window.showErrorMessage('Team selection required.');
      return;
    }

    const signInLabel = 'Sign In to TeXRA';
    const continueLabel = 'Continue with Available Members';
    const cancelLabel = 'Cancel';
    const resolution = await resolveTeamLaunch({
      teamId,
      customPresetsRaw: platform().workspaceState.get<unknown>(
        WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
      ),
      getAgents: getAgentsByCategory,
      canAccessRemoteCatalog: () =>
        SupabaseClient.canAccessRemoteAgentCatalog(),
      refreshRemote: () => refresh({ includeRemote: true }),
      choose: async (unavailableNames) => {
        const choice = await vscode.window.showWarningMessage(
          `This team has unavailable TeXRA-hosted members: ${unavailableNames.join(', ')}.`,
          signInLabel,
          continueLabel,
          cancelLabel,
        );
        if (choice === signInLabel) return 'sign-in';
        if (choice === continueLabel) return 'continue';
        return 'cancel';
      },
      signIn: async () =>
        Boolean(
          await vscode.commands.executeCommand<boolean>(AUTH_COMMANDS.SIGN_IN),
        ),
    });

    if (resolution.status === 'cancelled') return;
    if (resolution.status === 'unknown-team') {
      vscode.window.showErrorMessage(`Unknown team "${teamId}".`);
      return;
    }
    if (resolution.status === 'blocked') {
      vscode.window.showErrorMessage(
        `Team "${teamId}" cannot run: ${resolution.reason}.`,
      );
      return;
    }
    if (resolution.status === 'unavailable') {
      vscode.window.showErrorMessage(
        `Team "${teamId}" is unavailable: ${resolution.unavailableNames.join(', ')}.`,
      );
      return;
    }

    if (resolution.partial) {
      await vscode.window.showInformationMessage(
        `This team will run with available members only. Unavailable members: ${resolution.missingNames.join(', ')}.`,
      );
    }
    preparation = prepareMainViewTeamExecutionRequest(
      message,
      resolution.fields,
    );
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
