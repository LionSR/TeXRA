// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { isLatexFile } from '@common/files/fileTypeUtils';

// Local imports - utilities
import * as logger from '@logger/logUtils';
import { AbsoluteFS, pathToLocation } from '@utils/files';
import type { FileLocation } from '@utils/files';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@utils/config';

// Local imports - latex
import { compileLatex2Pdf } from '@latex/texTools';

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

  await openAndBuildLatex(uri, fileLocation, options.preserveFocus ?? false);
}

/**
 * Open LaTeX file, build it, and display PDF viewer.
 *
 * Files inside the workspace are compiled via LaTeX Workshop so the user
 * gets the full editor integration (synctex, diagnostics, etc.).
 *
 * Files outside the workspace (e.g. in run-storage) are compiled with the
 * internal `compileLatex2Pdf` helper which sets TEXINPUTS to include the
 * workspace root, ensuring project-local .sty / .cls / .bib files are found.
 */
async function openAndBuildLatex(
  uri: vscode.Uri,
  fileLocation: FileLocation,
  preserveFocus: boolean,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus });

  if (fileLocation.kind === 'workspace') {
    try {
      await vscode.commands.executeCommand('latex-workshop.build', uri);
    } catch (err) {
      logger.warn(
        CHANNEL,
        `LaTeX Workshop build failed: ${toErrorMessage(err)}`,
      );
    }
  } else {
    // Outside workspace — LaTeX Workshop cannot resolve project-local
    // packages, so compile internally with TEXINPUTS set.
    const outDir = path.join(path.dirname(uri.fsPath), 'build');
    const ok = await compileLatex2Pdf(pathToLocation(uri.fsPath), {
      outputDirectory: outDir,
    });
    if (!ok) {
      logger.warn(CHANNEL, `Internal LaTeX compilation failed for ${uri.fsPath}`);
    }
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
