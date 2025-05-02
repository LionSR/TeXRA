// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import {
  getWorkspacePath,
  getFullPathFromWorkspace,
  fileExists,
} from '../utils/workspaceFileUtils';

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

    // Create URIs for both files
    const baseUri = vscode.Uri.file(getFullPathFromWorkspace(fileToUse));
    const editedUri = vscode.Uri.file(getFullPathFromWorkspace(editedFile));

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
    const title = `Compare: ${editedFileName} ↔ ${baseFileName}`;

    // Open files in diff editor
    await vscode.commands.executeCommand(
      'vscode.diff',
      editedUri, // left-hand side (modified)
      baseUri, // right-hand side (original)
      title,
    );

    // Wait a short time for the diff editor to fully open, then check word wrap setting
    setTimeout(async () => {
      try {
        // Get current editor
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          // Check if word wrap is enabled through configuration for this editor
          const editorConfig = vscode.workspace.getConfiguration(
            'editor',
            editor.document.uri,
          );
          const isWordWrapEnabled = editorConfig.get('wordWrap') === 'on';

          // Only toggle if word wrap is not already on
          if (!isWordWrapEnabled) {
            await vscode.commands.executeCommand(
              'editor.action.toggleWordWrap',
            );
            logger.debug(CHANNEL, 'Toggled word wrap on for diff editor');
          } else {
            logger.debug(
              CHANNEL,
              'Word wrap already enabled, no change needed',
            );
          }
        }
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error handling word wrap: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, 300);

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
