// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { toErrorMessage } from '@common/errors';
import { registerDiffRefresh } from '@frontend/ui/diffView';
import * as logger from '@logger/logUtils';
import { flexibleFS, WorkspaceFS, pathToLocation } from '@utils/files';
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
  const inputFile = inputLocation.absolutePath;
  const baseFile = baseLocation.absolutePath;
  const editedFile = editedLocation.absolutePath;
  try {
    const fileToUse = baseFile || inputFile;
    if (!fileToUse || !editedFile) {
      vscode.window.showErrorMessage(
        'Both base file and edited file must be selected for comparison',
      );
      return;
    }

    // Create URIs for both files - handle both absolute and relative paths
    const baseAbsolute = path.isAbsolute(fileToUse)
      ? fileToUse
      : WorkspaceFS.fullPath(fileToUse);
    const editedAbsolute = path.isAbsolute(editedFile)
      ? editedFile
      : WorkspaceFS.fullPath(editedFile);
    const baseUri = vscode.Uri.file(baseAbsolute);
    const editedUri = vscode.Uri.file(editedAbsolute);

    // Verify both files exist
    if (!(await flexibleFS.exists(pathToLocation(fileToUse)))) {
      vscode.window.showErrorMessage(`Base file not found: ${fileToUse}`);
      return;
    }

    if (!(await flexibleFS.exists(pathToLocation(editedFile)))) {
      vscode.window.showErrorMessage(`Edited file not found: ${editedFile}`);
      return;
    }

    // Create title for the diff editor
    const baseFileName = path.basename(fileToUse);
    const editedFileName = path.basename(editedFile);
    const title = `Compare: ${editedFileName} ↔ ${baseFileName}`;
    // const title = `Compare: ${baseFileName} ↔ ${editedFileName}`;

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
    vscode.window.showErrorMessage(
      `Error comparing files: ${toErrorMessage(err)}`,
    );
    logger.error(CHANNEL, `Error in handleCompare: ${toErrorMessage(err)}`);
  }
}

/**
 * Handles accepting the content of the edited file and overwriting the base file
 */
async function handleAcceptEdited(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
  editedLocation: FileLocation,
) {
  const inputFile = inputLocation.absolutePath;
  const baseFile = baseLocation.absolutePath;
  const editedFile = editedLocation.absolutePath;
  try {
    const fileToUse = baseFile || inputFile;
    if (!fileToUse || !editedFile) {
      vscode.window.showErrorMessage(
        'Both base file and edited file must be selected to accept changes',
      );
      return;
    }

    // Verify both files exist
    if (!(await flexibleFS.exists(pathToLocation(fileToUse)))) {
      vscode.window.showErrorMessage(`Base file not found: ${fileToUse}`);
      return;
    }

    if (!(await flexibleFS.exists(pathToLocation(editedFile)))) {
      vscode.window.showErrorMessage(`Edited file not found: ${editedFile}`);
      return;
    }

    // Read content from edited file using workspace utilities
    const editedContent = await flexibleFS.read(pathToLocation(editedFile));

    // Confirm with user
    const baseFileName = path.basename(fileToUse);
    const editedFileName = path.basename(editedFile);

    const answer = await vscode.window.showWarningMessage(
      `This will overwrite '${baseFileName}' with content from '${editedFileName}'. Are you sure?`,
      { modal: true },
      'Yes',
      'Cancel',
    );

    if (answer !== 'Yes') {
      return;
    }

    // Write content to base file using workspace utilities
    await flexibleFS.write(pathToLocation(fileToUse), editedContent);

    vscode.window.showInformationMessage(
      `Successfully replaced '${baseFileName}' with content from '${editedFileName}'`,
    );

    logger.info(
      CHANNEL,
      `Copied content from ${editedFileName} to ${baseFileName}`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error accepting changes: ${toErrorMessage(err)}`,
    );
    logger.error(
      CHANNEL,
      `Error in handleAcceptEdited: ${toErrorMessage(err)}`,
    );
  }
}

export const compareCommands = {
  handleCompare,
  handleAcceptEdited,
};
