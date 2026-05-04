// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { extractAgentSuffix } from '@agent/utils/mergeFileUtils';
import {
  showLoggedErrorMessage,
  toErrorMessage,
} from '@common/errors/errorHandlingUtils';
import { bus } from '@eventBus/ProgressEventBus';
import { registerDiffRefresh } from '@frontend/ui/diffView';
import * as logger from '@logger/logUtils';
import { DIFF_REGISTRATION_DELAY_MS } from '@shared/constants/latex';
import {
  flexibleFS,
  createWorkspaceLocation,
  createRunStorageLocation,
  createExternalLocation,
} from '@utils/files';
import type { FileLocation } from '@utils/files';

const CHANNEL = 'CompareCommands';
logger.initialize(CHANNEL);

function validateFileLocations(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
  editedLocation: FileLocation,
  errorMessage: string,
): FileLocation | null {
  const fileToUseLocation = baseLocation ?? inputLocation;
  if (!fileToUseLocation || !editedLocation) {
    vscode.window.showErrorMessage(errorMessage);
    return null;
  }
  return fileToUseLocation;
}

async function validateFilesExist(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
): Promise<boolean> {
  if (!(await flexibleFS.exists(baseLocation))) {
    vscode.window.showErrorMessage(
      `Base file not found: ${baseLocation.absolutePath}`,
    );
    return false;
  }

  if (!(await flexibleFS.exists(editedLocation))) {
    vscode.window.showErrorMessage(
      `Edited file not found: ${editedLocation.absolutePath}`,
    );
    return false;
  }

  return true;
}

export function registerCompareCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.compare', handleCompare),
    vscode.commands.registerCommand('texra.acceptEdited', handleAcceptEdited),
  );
}

async function handleCompare(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
  editedLocation: FileLocation,
) {
  try {
    const fileToUseLocation = validateFileLocations(
      inputLocation,
      baseLocation,
      editedLocation,
      'Both base file and edited file must be selected for comparison',
    );
    if (!fileToUseLocation) return;

    if (!(await validateFilesExist(fileToUseLocation, editedLocation))) {
      return;
    }

    const baseUri = vscode.Uri.file(fileToUseLocation.absolutePath);
    const editedUri = vscode.Uri.file(editedLocation.absolutePath);
    const baseFileName = path.basename(fileToUseLocation.absolutePath);
    const editedFileName = path.basename(editedLocation.absolutePath);
    const title = `Compare: ${editedFileName} ↔ ${baseFileName}`;

    const contextKeyCommandId = 'vscode.getContextKeyValue';
    try {
      const location: string | undefined = await vscode.commands.executeCommand(
        contextKeyCommandId,
        'viewContainerLocation:texra',
      );

      if (location === 'secondarySideBar') {
        await vscode.commands.executeCommand('workbench.action.closePanel');
      }
    } catch (err) {
      const message = toErrorMessage(err);
      if (message.includes(`command '${contextKeyCommandId}' not found`)) {
        logger.warn(
          CHANNEL,
          `Could not check ProgressBoard location: command '${contextKeyCommandId}' not found`,
        );
      } else {
        throw err;
      }
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      editedUri,
      baseUri,
      title,
    );

    setTimeout(() => {
      registerDiffRefresh(editedUri, baseUri, title);
    }, DIFF_REGISTRATION_DELAY_MS);

    logger.info(
      CHANNEL,
      `Opened diff comparison between ${baseFileName} and ${editedFileName}`,
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error comparing files', err);
  }
}

async function handleAcceptEdited(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
  editedLocation: FileLocation,
) {
  try {
    const fileToUseLocation = validateFileLocations(
      inputLocation,
      baseLocation,
      editedLocation,
      'Both base file and edited file must be selected to accept changes',
    );
    if (!fileToUseLocation) return;

    if (!(await validateFilesExist(fileToUseLocation, editedLocation))) {
      return;
    }

    const basePath = fileToUseLocation.absolutePath;
    const editedPath = editedLocation.absolutePath;
    const editedFileName = path.basename(editedPath);
    const baseExt = path.extname(basePath).toLowerCase();
    const editedExt = path.extname(editedPath).toLowerCase();

    const { targetLocation, targetFileName, isNewFile } =
      baseExt !== editedExt
        ? getNewFileTarget(fileToUseLocation, editedPath)
        : {
            targetLocation: fileToUseLocation,
            targetFileName: path.basename(basePath),
            isNewFile: false,
          };

    const targetExists = isNewFile && (await flexibleFS.exists(targetLocation));

    let action: string;
    if (targetExists) {
      action = 'overwrite existing';
    } else if (isNewFile) {
      action = 'create';
    } else {
      action = 'overwrite';
    }
    const extensionNote = isNewFile
      ? `Extensions differ (${baseExt} vs ${editedExt}). `
      : '';
    const confirmMessage = `${extensionNote}This will ${action} '${targetFileName}' with content from '${editedFileName}'. Are you sure?`;

    const answer = await vscode.window.showWarningMessage(
      confirmMessage,
      { modal: true },
      'Yes',
      'Cancel',
    );

    if (answer !== 'Yes') {
      return;
    }

    const editedContent = await flexibleFS.read(editedLocation);
    await flexibleFS.write(targetLocation, editedContent);

    if (targetLocation.kind === 'workspace') {
      bus.emit('workspaceFilesWritten', {
        absolutePaths: [targetLocation.absolutePath],
      });
    }

    const operation = isNewFile && !targetExists ? 'created' : 'replaced';
    const successMessage = `Successfully ${operation} '${targetFileName}' with content from '${editedFileName}'`;

    vscode.window.showInformationMessage(successMessage);
    logger.info(CHANNEL, successMessage);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error accepting changes', err);
  }
}

function getNewFileTarget(
  baseLocation: FileLocation,
  editedPath: string,
): { targetLocation: FileLocation; targetFileName: string; isNewFile: true } {
  const basePath = baseLocation.absolutePath;
  const baseNameWithoutExt = path.parse(basePath).name;
  const editedNameWithoutExt = path.parse(editedPath).name;
  const editedExt = path.extname(editedPath);

  const agentSuffix = extractAgentSuffix(
    baseNameWithoutExt,
    editedNameWithoutExt,
  );
  const targetFileName = agentSuffix
    ? `${baseNameWithoutExt}_${agentSuffix}${editedExt}`
    : path.basename(editedPath);

  const targetAbsolutePath = path.join(path.dirname(basePath), targetFileName);

  let targetLocation: FileLocation;
  if (baseLocation.kind === 'external') {
    targetLocation = createExternalLocation(targetAbsolutePath);
  } else {
    const targetRelativePath = path.join(
      path.dirname(baseLocation.relativePath),
      targetFileName,
    );
    targetLocation =
      baseLocation.kind === 'workspace'
        ? createWorkspaceLocation(targetAbsolutePath, targetRelativePath)
        : createRunStorageLocation(
            targetAbsolutePath,
            targetRelativePath,
            baseLocation.executionId,
          );
  }

  return { targetLocation, targetFileName, isNewFile: true };
}
