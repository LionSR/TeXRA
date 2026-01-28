import * as path from 'path';

import * as vscode from 'vscode';

import { showLoggedMessage, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

import { findFilesFromPatterns } from './utils';
import { TEMP_EXTENSIONS } from './constants';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export async function runPackLatexdiffvc(
  inputFile: string,
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  const filePatterns = [`${baseName}-diff${commitHash}`];

  const mainFiles = findFilesFromPatterns(inputDir, filePatterns, [
    '.tex',
    '.pdf',
  ]);
  const tempFiles = findFilesFromPatterns(
    inputDir,
    filePatterns,
    TEMP_EXTENSIONS,
  );

  if (mainFiles.length === 0 && tempFiles.length === 0) {
    logger.warn(CHANNEL, 'No files found to process.');
    vscode.window.showInformationMessage(
      'No LaTeX diff files found to process',
    );
    return;
  }

  if (clean) {
    for (const file of [...mainFiles, ...tempFiles]) {
      await WorkspaceFS.delete(file);
    }
    logger.info(CHANNEL, 'Cleanup complete.');
    vscode.window.showInformationMessage('LaTeXdiff files cleaned');
    return;
  }

  const now = new Date()
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .split('.')[0];
  const outputFolder = path.join(
    inputDir,
    'Diffs',
    `${now}_${baseName}_${commitHash}`,
  );

  try {
    let dirCreated = false;
    for (const file of mainFiles) {
      if (!dirCreated) {
        await WorkspaceFS.createDir(outputFolder);
        dirCreated = true;
      }
      await WorkspaceFS.rename(
        file,
        path.join(outputFolder, path.basename(file)),
      );
    }

    for (const file of tempFiles) {
      await WorkspaceFS.delete(file);
    }

    if (dirCreated) {
      logger.info(CHANNEL, `Files packed into ${outputFolder}`);
      vscode.window.showInformationMessage(`Files packed into ${outputFolder}`);
    }
  } catch (err) {
    logger.error(CHANNEL, `Error during packing: ${toErrorMessage(err)}`);
    vscode.window.showErrorMessage(`Error during packing: ${err}`);
  }
}

export async function runPackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  if (!inputFiles || inputFiles.length === 0) {
    await showLoggedMessage(
      CHANNEL,
      'No input files provided for multiple LaTeX diff packing',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    await runPackLatexdiffvc(inputFile, commitHash, clean);
  }
}

export async function runCleanLatexdiffvc(
  inputFile: string,
  commitHash: string,
): Promise<void> {
  await runPackLatexdiffvc(inputFile, commitHash, true);
}

export async function runCleanLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  await runPackLatexdiffvcMultiple(inputFiles, commitHash, true);
}
