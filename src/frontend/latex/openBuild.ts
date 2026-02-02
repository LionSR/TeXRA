// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { isLatexFile } from '@common/files/fileTypeUtils';

// Local imports - utilities
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';
import type { FileLocation } from '@utils/files';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@utils/config';

const CHANNEL = 'OpenBuildUtils';

/**
 * Open a file, compile if it is TeX, and display the resulting PDF.
 * The PDF viewer is refreshed if already loaded.
 */
export async function openBuildDisplayIfTex(
  fileLocation: FileLocation,
  options: { preserveFocus?: boolean } = {},
): Promise<void> {
  const absolutePath = fileLocation.absolutePath;

  const exists = await AbsoluteFS.exists(absolutePath);
  if (!exists) {
    vscode.window.showErrorMessage(`File not found: ${absolutePath}`);
    return;
  }

  const uri = vscode.Uri.file(absolutePath);

  if (!isLatexFile(absolutePath)) {
    await vscode.commands.executeCommand('vscode.open', uri);
    return;
  }

  await openAndBuildLatex(uri, options.preserveFocus ?? false);
}

/**
 * Open LaTeX file, build it, and display PDF viewer.
 */
async function openAndBuildLatex(
  uri: vscode.Uri,
  preserveFocus: boolean,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus });

  try {
    await vscode.commands.executeCommand('latex-workshop.build', uri);
  } catch (err) {
    logger.warn(CHANNEL, `LaTeX Workshop build failed: ${toErrorMessage(err)}`);
  }

  scheduleViewerDisplay();
}

/**
 * Schedule PDF viewer display and refresh after build.
 */
function scheduleViewerDisplay(): void {
  setTimeout(() => {
    vscode.commands.executeCommand('latex-workshop.view').then(
      () => {
        setTimeout(() => {
          vscode.commands.executeCommand('latex-workshop.refresh-viewer');
        }, LATEX_VIEWER_REFRESH_DELAY_MS);
      },
      (err) => {
        logger.warn(CHANNEL, `Viewer display failed: ${toErrorMessage(err)}`);
      },
    );
  }, LATEX_VIEWER_OPEN_DELAY_MS);
}
