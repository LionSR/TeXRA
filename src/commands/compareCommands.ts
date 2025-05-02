// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath, fileExists } from '../utils/workspaceFileUtils';

const CHANNEL = 'CompareCommands';
logger.initialize(CHANNEL);

/**
 * Register comparison related commands
 */
export function registerCompareCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.compare', handleCompare),
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
    const fileToUse = baseFile || inputFile;
    if (!fileToUse || !editedFile) {
      vscode.window.showErrorMessage(
        'Both base file and edited file must be selected for comparison',
      );
      return;
    }

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Create URIs for both files
    const baseUri = vscode.Uri.file(path.join(workspacePath, fileToUse));
    const editedUri = vscode.Uri.file(path.join(workspacePath, editedFile));

    // Verify both files exist
    if (!(await fileExists(fileToUse))) {
      vscode.window.showErrorMessage(`Base file not found: ${fileToUse}`);
      return;
    }

    if (!(await fileExists(editedFile))) {
      vscode.window.showErrorMessage(`Edited file not found: ${editedFile}`);
      return;
    }

    // Create title for the diff editor
    const baseFileName = path.basename(fileToUse);
    const editedFileName = path.basename(editedFile);
    const title = `Compare: ${baseFileName} ↔ ${editedFileName}`;

    // Open files in diff editor
    await vscode.commands.executeCommand(
      'vscode.diff',
      baseUri, // right-hand side (original)
      editedUri, // left-hand side (modified)
      title,
    );

    logger.info(
      CHANNEL,
      `Opened diff comparison between ${baseFileName} and ${editedFileName}`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error comparing files: ${err instanceof Error ? err.message : String(err)}`,
    );
    logger.error(
      CHANNEL,
      `Error in handleCompare: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const compareCommands = {
  handleCompare,
};
