// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { showLoggedMessage, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

// Local imports - housekeeping utils
import { findFilesFromPatterns } from './utils';
import { TEMP_EXTENSIONS } from './constants';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export async function runPackLatexdiffvc(
  inputFile: string,
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  logger.debug(
    CHANNEL,
    `Starting LaTeX diff packing with inputFile=${inputFile}, commitHash=${commitHash}, clean=${clean}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  logger.debug(
    CHANNEL,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  logger.debug(CHANNEL, `File patterns: ${filePatterns}`);

  const filesToProcess = findFilesFromPatterns(inputDir, filePatterns, [
    '.tex',
    '.pdf',
  ]);
  logger.debug(
    CHANNEL,
    `Files to process: ${filesToProcess.length > 0 ? filesToProcess.join(', ') : 'none'}`,
  );

  const filesToDelete = findFilesFromPatterns(
    inputDir,
    filePatterns,
    TEMP_EXTENSIONS,
  );
  logger.debug(
    CHANNEL,
    `Temporary files: ${filesToDelete.length > 0 ? filesToDelete.join(', ') : 'none'}`,
  );

  if (filesToProcess.length > 0) {
    if (clean) {
      // Delete all files if clean mode
      for (const file of [...filesToProcess, ...filesToDelete]) {
        await WorkspaceFS.delete(file);
      }
      logger.info(CHANNEL, 'Cleanup complete.');
      vscode.window.showInformationMessage('LaTeXdiff files cleaned');
    } else {
      // Move files to output folder only when needed
      const now = new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0];
      const outputFolder = path.join(
        inputDir,
        'Diffs',
        `${now}_${baseName}_${commitHash}`,
      );

      let anyFilesPacked = false;

      try {
        // Move main files
        for (const file of filesToProcess) {
          if (!anyFilesPacked) {
            await WorkspaceFS.createDir(outputFolder);
            logger.debug(CHANNEL, `Created output directory: ${outputFolder}`);
            anyFilesPacked = true;
          }
          await WorkspaceFS.rename(
            file,
            path.join(outputFolder, path.basename(file)),
          );
        }

        // Delete temporary files
        for (const file of filesToDelete) {
          await WorkspaceFS.delete(file);
        }

        if (anyFilesPacked) {
          logger.info(CHANNEL, `Files packed into ${outputFolder}`);
          vscode.window.showInformationMessage(
            `Files packed into ${outputFolder}`,
          );
        }
      } catch (err) {
        logger.error(CHANNEL, `Error during packing: ${toErrorMessage(err)}`);
        vscode.window.showErrorMessage(`Error during packing: ${err}`);
      }
    }
  } else {
    logger.warn(CHANNEL, 'No files found to process.');
    vscode.window.showInformationMessage(
      'No LaTeX diff files found to process',
    );
  }
}

export async function runPackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  logger.debug(
    CHANNEL,
    `Starting multiple LaTeX diff packing with commitHash=${commitHash}, clean=${clean}`,
  );
  logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    await showLoggedMessage(
      CHANNEL,
      'No input files provided for multiple LaTeX diff packing',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    logger.debug(CHANNEL, `Processing file: ${inputFile}`);
    await runPackLatexdiffvc(inputFile, commitHash, clean);
  }

  logger.debug(CHANNEL, 'Multiple LaTeX diff files processed');
}

export async function runCleanLatexdiffvc(
  inputFile: string,
  commitHash: string,
): Promise<void> {
  logger.debug(
    CHANNEL,
    `Starting LaTeX diff cleaning with inputFile=${inputFile}, commitHash=${commitHash}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  logger.debug(
    CHANNEL,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  logger.debug(CHANNEL, `File patterns: ${filePatterns}`);

  const filesToDelete = [
    ...findFilesFromPatterns(inputDir, filePatterns, ['.tex', '.pdf']),
    ...findFilesFromPatterns(inputDir, filePatterns, TEMP_EXTENSIONS),
  ];
  logger.debug(
    CHANNEL,
    `Files to delete: ${filesToDelete.length > 0 ? filesToDelete.join(', ') : 'none'}`,
  );

  if (filesToDelete.length > 0) {
    // Delete all found files
    for (const file of filesToDelete) {
      await WorkspaceFS.delete(file);
    }
    logger.info(CHANNEL, 'Cleanup complete.');
    vscode.window.showInformationMessage('LaTeXdiff files cleaned');
  } else {
    logger.warn(CHANNEL, 'No files found to clean.');
    vscode.window.showInformationMessage('No LaTeX diff files found to clean');
  }
}

export async function runCleanLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  logger.debug(
    CHANNEL,
    `Starting multiple LaTeX diff cleaning with commitHash=${commitHash}`,
  );
  logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    await showLoggedMessage(
      CHANNEL,
      'No input files provided for multiple LaTeX diff cleaning',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    logger.debug(CHANNEL, `Processing file: ${inputFile}`);
    await runCleanLatexdiffvc(inputFile, commitHash);
  }

  logger.info(CHANNEL, 'Multiple LaTeX diff files cleaned');
}
