// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import {
  deleteFile,
  moveFile,
  findFileInBuild,
  createDirectory,
  fileExists,
} from '../utils/fileUtils';

// Local imports - housekeeping
import { TEMP_EXTENSIONS } from './constants';

const CHANNEL = 'Housekeeping';
logger.initializeLogging(CHANNEL);

export async function runPackLatexDiffVC(
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

  const filesToProcess: string[] = [];
  const filesToDelete: string[] = [];

  // Find files to process
  for (const pattern of filePatterns) {
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath) {
        logger.debug(CHANNEL, `Found file to process: ${filePath}`);
        filesToProcess.push(filePath);

        // Find associated temporary files
        for (const tempExt of TEMP_EXTENSIONS) {
          const tempFile = path.join(
            path.dirname(filePath),
            `${pattern}${tempExt}`,
          );
          if (await fileExists(tempFile)) {
            logger.debug(CHANNEL, `Found temporary file: ${tempFile}`);
            filesToDelete.push(tempFile);
          }
        }
      }
    }
  }

  if (filesToProcess.length > 0) {
    if (clean) {
      // Delete all files if clean mode
      for (const file of [...filesToProcess, ...filesToDelete]) {
        await deleteFile(file);
      }
      logger.info(CHANNEL, 'Cleanup complete.');
      vscode.window.showInformationMessage('LaTeX diff files cleaned');
    } else {
      // Move files to output folder
      const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
      const outputFolder = path.join(
        inputDir,
        'Diffs',
        `${now}_${baseName}_${commitHash}`,
      );

      try {
        await createDirectory(outputFolder);
        logger.debug(CHANNEL, `Created output directory: ${outputFolder}`);

        // Move main files
        for (const file of filesToProcess) {
          await moveFile(file, path.join(outputFolder, path.basename(file)));
        }

        // Delete temporary files
        for (const file of filesToDelete) {
          await deleteFile(file);
        }

        logger.info(CHANNEL, `Files packed into ${outputFolder}`);
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error during packing: ${err instanceof Error ? err.message : String(err)}`,
        );
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

export async function runPackLatexDiffVCMultiple(
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
    logger.error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff packing',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    logger.debug(CHANNEL, `Processing file: ${inputFile}`);
    await runPackLatexDiffVC(inputFile, commitHash, clean);
  }

  logger.info(CHANNEL, 'Multiple LaTeX diff files processed');
}

export async function runCleanLatexDiffVC(
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

  const filesToDelete: string[] = [];

  // Find files to delete
  for (const pattern of filePatterns) {
    // Find main files (.tex and .pdf)
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath) {
        logger.debug(CHANNEL, `Found main file to delete: ${filePath}`);
        filesToDelete.push(filePath);
      }
    }

    // Find all temporary files
    for (const tempExt of TEMP_EXTENSIONS) {
      const filePath = await findFileInBuild(inputDir, pattern, tempExt);
      if (filePath) {
        logger.debug(CHANNEL, `Found temporary file to delete: ${filePath}`);
        filesToDelete.push(filePath);
      }
    }
  }

  if (filesToDelete.length > 0) {
    // Delete all found files
    for (const file of filesToDelete) {
      await deleteFile(file);
    }
    logger.info(CHANNEL, 'Cleanup complete.');
    vscode.window.showInformationMessage('LaTeX diff files cleaned');
  } else {
    logger.warn(CHANNEL, 'No files found to clean.');
    vscode.window.showInformationMessage('No LaTeX diff files found to clean');
  }
}

export async function runCleanLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  logger.debug(
    CHANNEL,
    `Starting multiple LaTeX diff cleaning with commitHash=${commitHash}`,
  );
  logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    logger.error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff cleaning',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    logger.debug(CHANNEL, `Processing file: ${inputFile}`);
    await runCleanLatexDiffVC(inputFile, commitHash);
  }

  logger.info(CHANNEL, 'Multiple LaTeX diff files cleaned');
}
