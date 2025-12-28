// Third-party imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - common
import { isTexFile } from '@common/files/fileTypeUtils';

// Local imports - log
import * as logger from '@logger/logUtils';
import { WorkspaceFS, AbsoluteFS, resolveFilePath } from '@utils/files';
import type { FileLocation } from '@utils/files';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@utils/config';

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
    const isAbsolute = path.isAbsolute(file);
    const exists = isAbsolute
      ? await AbsoluteFS.exists(file)
      : await WorkspaceFS.exists(file);
    if (!exists) {
      vscode.window.showErrorMessage(`File not found: ${file}`);
      return;
    }

    const fullPath = resolveFilePath(file);
    const uri = vscode.Uri.file(fullPath);

    if (isTexFile(file)) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        // preview: false,
        preview: true,
        preserveFocus: options.preserveFocus ?? false,
      });

      try {
        await vscode.commands.executeCommand('latex-workshop.build', uri);
      } catch (err) {
        logger.warn(CHANNEL, `LaTeX Workshop build failed: ${err}`);
      }
    } else {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  } catch (err) {
    logger.error(CHANNEL, `Error opening file: ${err}`);
  }
}

/**
 * Open a file, compile if it is TeX, and display the resulting PDF.
 * The PDF viewer is refreshed if already loaded.
 *
 * @param file Relative path to the file within the workspace
 * @param options Optional settings for showing the document
 */
export async function openBuildDisplayIfTex(
  fileLocation: FileLocation,
  options: { preserveFocus?: boolean } = {},
): Promise<void> {
  const file = fileLocation.absolutePath;
  await openAndBuildIfTex(file, options);

  if (isTexFile(file)) {
    try {
      setTimeout(async () => {
        await vscode.commands.executeCommand('latex-workshop.view');
        setTimeout(
          () => vscode.commands.executeCommand('latex-workshop.refresh-viewer'),
          LATEX_VIEWER_REFRESH_DELAY_MS,
        );
      }, LATEX_VIEWER_OPEN_DELAY_MS);
    } catch (err) {
      logger.warn(CHANNEL, `Viewer display failed: ${err}`);
    }
  }
}
