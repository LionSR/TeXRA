// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { extractAgentSuffix } from '@agent/utils';
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import { registerDiffRefresh } from '@frontend/ui/diffView';
import * as logger from '@logger/logUtils';
import {
  flexibleFS,
  createWorkspaceLocation,
  createRunStorageLocation,
  createExternalLocation,
} from '@utils/files';
import type { FileLocation } from '@utils/files';
import { DIFF_REGISTRATION_DELAY_MS } from '@utils/config';

const CHANNEL = 'CompareCommands';
logger.initialize(CHANNEL);

/**
 * Register comparison related commands
 */
export function registerCompareCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.compare', handleCompare),
    vscode.commands.registerCommand('texra.acceptEdited', handleAcceptEdited),
  );
}

/**
 * Handles the compare command to show two files in VS Code's built-in diff editor
 */
async function handleCompare(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
  editedLocation: FileLocation,
) {
  try {
    const fileToUseLocation = baseLocation ?? inputLocation;
    if (!fileToUseLocation || !editedLocation) {
      vscode.window.showErrorMessage(
        'Both base file and edited file must be selected for comparison',
      );
      return;
    }

    // Verify both files exist
    if (!(await flexibleFS.exists(fileToUseLocation))) {
      vscode.window.showErrorMessage(
        `Base file not found: ${fileToUseLocation.absolutePath}`,
      );
      return;
    }

    if (!(await flexibleFS.exists(editedLocation))) {
      vscode.window.showErrorMessage(
        `Edited file not found: ${editedLocation.absolutePath}`,
      );
      return;
    }

    // Create URIs for diff editor
    const baseUri = vscode.Uri.file(fileToUseLocation.absolutePath);
    const editedUri = vscode.Uri.file(editedLocation.absolutePath);

    // Create title for the diff editor
    const baseFileName = path.basename(fileToUseLocation.absolutePath);
    const editedFileName = path.basename(editedLocation.absolutePath);
    const title = `Compare: ${editedFileName} ↔ ${baseFileName}`;

    // If the ProgressBoard lives in the secondary sidebar, close the bottom
    // panel to give the diff view more space. If the view is in the panel
    // already, leave it open.
    const contextKeyCommandId = 'vscode.getContextKeyValue';
    try {
      const location: string | undefined = await vscode.commands.executeCommand(
        contextKeyCommandId,
        'viewContainerLocation:texra-panel',
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

    // Open files in diff editor
    await vscode.commands.executeCommand(
      'vscode.diff',
      editedUri, // left-hand side (modified)
      baseUri, // right-hand side (original)
      title,
    );

    // Wait a short time for the diff editor to fully open, then register listeners
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

/**
 * Handles accepting the content of the edited file.
 * If extensions differ, creates a new file instead of overwriting.
 */
async function handleAcceptEdited(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
  editedLocation: FileLocation,
) {
  try {
    const fileToUseLocation = baseLocation ?? inputLocation;
    if (!fileToUseLocation || !editedLocation) {
      vscode.window.showErrorMessage(
        'Both base file and edited file must be selected to accept changes',
      );
      return;
    }

    // Verify both files exist
    if (!(await flexibleFS.exists(fileToUseLocation))) {
      vscode.window.showErrorMessage(
        `Base file not found: ${fileToUseLocation.absolutePath}`,
      );
      return;
    }

    if (!(await flexibleFS.exists(editedLocation))) {
      vscode.window.showErrorMessage(
        `Edited file not found: ${editedLocation.absolutePath}`,
      );
      return;
    }

    const basePath = fileToUseLocation.absolutePath;
    const editedPath = editedLocation.absolutePath;
    const editedFileName = path.basename(editedPath);
    const baseExt = path.extname(basePath).toLowerCase();
    const editedExt = path.extname(editedPath).toLowerCase();

    // Determine target: new file if extensions differ, otherwise overwrite base
    const { targetLocation, targetFileName, isNewFile } =
      baseExt !== editedExt
        ? getNewFileTarget(fileToUseLocation, editedPath)
        : {
            targetLocation: fileToUseLocation,
            targetFileName: path.basename(basePath),
            isNewFile: false,
          };

    // Check if new file would overwrite an existing file
    const targetExists = isNewFile && (await flexibleFS.exists(targetLocation));

    let confirmMessage: string;
    if (isNewFile && targetExists) {
      confirmMessage = `Extensions differ (${baseExt} vs ${editedExt}). This will overwrite existing '${targetFileName}' with content from '${editedFileName}'. Are you sure?`;
    } else if (isNewFile) {
      confirmMessage = `Extensions differ (${baseExt} vs ${editedExt}). This will create '${targetFileName}' with content from '${editedFileName}'. Are you sure?`;
    } else {
      confirmMessage = `This will overwrite '${targetFileName}' with content from '${editedFileName}'. Are you sure?`;
    }

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

    const successMessage =
      isNewFile && !targetExists
        ? `Successfully created '${targetFileName}' with content from '${editedFileName}'`
        : `Successfully replaced '${targetFileName}' with content from '${editedFileName}'`;

    vscode.window.showInformationMessage(successMessage);
    logger.info(CHANNEL, successMessage);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error accepting changes', err);
  }
}

/**
 * Determines the target file when extensions differ.
 * Creates filename: {baseName}_{agent}.{editedExt} or falls back to edited filename.
 * Preserves the location kind (workspace/runStorage/external) from the base file.
 */
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

  // Preserve location kind from base file
  let targetLocation: FileLocation;
  switch (baseLocation.kind) {
    case 'workspace': {
      const targetRelativePath = path.join(
        path.dirname(baseLocation.relativePath),
        targetFileName,
      );
      targetLocation = createWorkspaceLocation(
        targetAbsolutePath,
        targetRelativePath,
      );
      break;
    }
    case 'runStorage': {
      const targetRelativePath = path.join(
        path.dirname(baseLocation.relativePath),
        targetFileName,
      );
      targetLocation = createRunStorageLocation(
        targetAbsolutePath,
        targetRelativePath,
        baseLocation.executionId,
      );
      break;
    }
    case 'external':
      targetLocation = createExternalLocation(targetAbsolutePath);
      break;
  }

  return { targetLocation, targetFileName, isNewFile: true };
}

export const compareCommands = {
  handleCompare,
  handleAcceptEdited,
};
