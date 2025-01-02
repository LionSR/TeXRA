import * as vscode from 'vscode';
import * as path from 'path';
import { debug, info, warn, error } from '../logger/logUtils';
import {
  deleteFile,
  moveFile,
  findFileInBuild,
  createDirectory,
  fileExists,
} from '../utils/fileUtils';
import { TEMP_EXTENSIONS } from './constants';

const CHANNEL = 'Housekeeping';

export async function runPackLatexDiffVC(
  inputFile: string,
  commitHash: string,
  clean: boolean = false,
): Promise<void> {
  debug(
    CHANNEL,
    `Starting LaTeX diff packing with inputFile=${inputFile}, commitHash=${commitHash}, clean=${clean}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  debug(CHANNEL, `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  debug(CHANNEL, `File patterns: ${filePatterns}`);

  const filesToProcess: string[] = [];
  const filesToDelete: string[] = [];

  // Find files to process
  for (const pattern of filePatterns) {
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath) {
        debug(CHANNEL, `Found file to process: ${filePath}`);
        filesToProcess.push(filePath);

        // Find associated temporary files
        for (const tempExt of TEMP_EXTENSIONS) {
          const tempFile = path.join(
            path.dirname(filePath),
            `${pattern}${tempExt}`,
          );
          if (await fileExists(tempFile)) {
            debug(CHANNEL, `Found temporary file: ${tempFile}`);
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
      info(CHANNEL, 'Cleanup complete.');
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
        debug(CHANNEL, `Created output directory: ${outputFolder}`);

        // Move main files
        for (const file of filesToProcess) {
          await moveFile(file, path.join(outputFolder, path.basename(file)));
        }

        // Delete temporary files
        for (const file of filesToDelete) {
          await deleteFile(file);
        }

        info(CHANNEL, `Files packed into ${outputFolder}`);
      } catch (err) {
        error(
          CHANNEL,
          `Error during packing: ${err instanceof Error ? err.message : String(err)}`,
        );
        vscode.window.showErrorMessage(`Error during packing: ${err}`);
      }
    }
  } else {
    warn(CHANNEL, 'No files found to process.');
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
  debug(
    CHANNEL,
    `Starting multiple LaTeX diff packing with commitHash=${commitHash}, clean=${clean}`,
  );
  debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff packing',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    debug(CHANNEL, `Processing file: ${inputFile}`);
    await runPackLatexDiffVC(inputFile, commitHash, clean);
  }

  info(CHANNEL, 'Multiple LaTeX diff files processed');
}

export async function runCleanLatexDiffVC(
  inputFile: string,
  commitHash: string,
): Promise<void> {
  debug(
    CHANNEL,
    `Starting LaTeX diff cleaning with inputFile=${inputFile}, commitHash=${commitHash}`,
  );

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  debug(CHANNEL, `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  // Define patterns for files to process
  const filePatterns = [`${baseName}-diff${commitHash}`];
  debug(CHANNEL, `File patterns: ${filePatterns}`);

  const filesToDelete: string[] = [];

  // Find files to delete
  for (const pattern of filePatterns) {
    // Find main files (.tex and .pdf)
    for (const ext of ['.tex', '.pdf']) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath) {
        debug(CHANNEL, `Found main file to delete: ${filePath}`);
        filesToDelete.push(filePath);
      }
    }

    // Find all temporary files
    for (const tempExt of TEMP_EXTENSIONS) {
      const filePath = await findFileInBuild(inputDir, pattern, tempExt);
      if (filePath) {
        debug(CHANNEL, `Found temporary file to delete: ${filePath}`);
        filesToDelete.push(filePath);
      }
    }
  }

  if (filesToDelete.length > 0) {
    // Delete all found files
    for (const file of filesToDelete) {
      await deleteFile(file);
    }
    info(CHANNEL, 'Cleanup complete.');
    vscode.window.showInformationMessage('LaTeX diff files cleaned');
  } else {
    warn(CHANNEL, 'No files found to clean.');
    vscode.window.showInformationMessage('No LaTeX diff files found to clean');
  }
}

export async function runCleanLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  debug(
    CHANNEL,
    `Starting multiple LaTeX diff cleaning with commitHash=${commitHash}`,
  );
  debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

  if (!inputFiles || inputFiles.length === 0) {
    error(CHANNEL, 'No input files provided');
    vscode.window.showErrorMessage(
      'No input files provided for multiple LaTeX diff cleaning',
    );
    return;
  }

  for (const inputFile of inputFiles) {
    debug(CHANNEL, `Processing file: ${inputFile}`);
    await runCleanLatexDiffVC(inputFile, commitHash);
  }

  info(CHANNEL, 'Multiple LaTeX diff files cleaned');
}
