// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { fileExists, getFullPathFromWorkspace } from './workspaceFileUtils';

const CHANNEL = 'OpenBuildUtils';
logger.initialize(CHANNEL);

/**
 * Open a file and run a LaTeX build if it is a TeX file.
 *
 * @param file Relative path to the file within the workspace
 * @param options Optional settings for showing the document
 */
export async function openAndBuildIfTex(
  file: string,
  options: { preserveFocus?: boolean } = {},
): Promise<void> {
  try {
    if (!(await fileExists(file))) {
      vscode.window.showErrorMessage(`File not found: ${file}`);
      return;
    }

    const uri = vscode.Uri.file(getFullPathFromWorkspace(file));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: options.preserveFocus ?? false,
    });

    if (file.toLowerCase().endsWith('.tex')) {
      try {
        await vscode.commands.executeCommand('latex-workshop.build', uri);
      } catch (err) {
        logger.warn(CHANNEL, `LaTeX Workshop build failed: ${err}`);
      }
    }
  } catch (err) {
    logger.error(CHANNEL, `Error opening file: ${err}`);
  }
}
