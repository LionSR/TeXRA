// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { registerDiffRefresh } from '@frontend/ui/diffView';
import { DIFF_REGISTRATION_DELAY_MS } from '@utils/config';
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

const CHANNEL = 'CompareCommands';
logger.initialize(CHANNEL);

type CompareValidationErrorCode =
  | 'MISSING_SELECTION'
  | 'BASE_FILE_NOT_FOUND'
  | 'EDITED_FILE_NOT_FOUND';

export class CompareCommandValidationError extends Error {
  constructor(
    public readonly code: CompareValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompareCommandValidationError';
  }
}

interface DiffValidationResult {
  baseRelativePath: string;
  editedRelativePath: string;
  baseUri: vscode.Uri;
  editedUri: vscode.Uri;
  baseFileName: string;
  editedFileName: string;
}

const VALIDATION_ERROR_PREFIX = 'Unable to prepare files for diff';

export async function validateDiffFiles(
  inputFile: string,
  baseFile: string,
  editedFile: string,
): Promise<DiffValidationResult> {
  const baseRelativePath = baseFile || inputFile;

  if (!baseRelativePath || !editedFile) {
    const error = new CompareCommandValidationError(
      'MISSING_SELECTION',
      'Both base file and edited file must be selected.',
    );
    await showLoggedErrorMessage(CHANNEL, VALIDATION_ERROR_PREFIX, error);
    throw error;
  }

  if (!(await WorkspaceFS.exists(baseRelativePath))) {
    const error = new CompareCommandValidationError(
      'BASE_FILE_NOT_FOUND',
      `Base file not found: ${baseRelativePath}`,
    );
    await showLoggedErrorMessage(CHANNEL, VALIDATION_ERROR_PREFIX, error);
    throw error;
  }

  if (!(await WorkspaceFS.exists(editedFile))) {
    const error = new CompareCommandValidationError(
      'EDITED_FILE_NOT_FOUND',
      `Edited file not found: ${editedFile}`,
    );
    await showLoggedErrorMessage(CHANNEL, VALIDATION_ERROR_PREFIX, error);
    throw error;
  }

  const normalizedBasePath = path.normalize(baseRelativePath);
  const normalizedEditedPath = path.normalize(editedFile);

  return {
    baseRelativePath: normalizedBasePath,
    editedRelativePath: normalizedEditedPath,
    baseUri: vscode.Uri.file(WorkspaceFS.fullPath(normalizedBasePath)),
    editedUri: vscode.Uri.file(WorkspaceFS.fullPath(normalizedEditedPath)),
    baseFileName: path.basename(normalizedBasePath),
    editedFileName: path.basename(normalizedEditedPath),
  };
}

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
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  try {
    const { baseUri, editedUri, baseFileName, editedFileName } =
      await validateDiffFiles(inputFile, baseFile, editedFile);

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
      const message = err instanceof Error ? err.message : String(err);
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
    if (err instanceof CompareCommandValidationError) {
      return;
    }
    await showLoggedErrorMessage(CHANNEL, 'Error comparing files', err);
  }
}

/**
 * Handles accepting the content of the edited file and overwriting the base file
 */
async function handleAcceptEdited(
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  try {
    const {
      baseRelativePath,
      editedRelativePath,
      baseFileName,
      editedFileName,
    } = await validateDiffFiles(inputFile, baseFile, editedFile);

    // Read content from edited file using workspace utilities
    const editedContent = await WorkspaceFS.read(editedRelativePath);

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
    await WorkspaceFS.write(baseRelativePath, editedContent);

    vscode.window.showInformationMessage(
      `Successfully replaced '${baseFileName}' with content from '${editedFileName}'`,
    );

    logger.info(
      CHANNEL,
      `Copied content from ${editedFileName} to ${baseFileName}`,
    );
  } catch (err) {
    if (err instanceof CompareCommandValidationError) {
      return;
    }
    await showLoggedErrorMessage(CHANNEL, 'Error accepting changes', err);
  }
}

export const compareCommands = {
  handleCompare,
  handleAcceptEdited,
};
