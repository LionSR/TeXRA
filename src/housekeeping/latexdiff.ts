import * as path from 'node:path';

import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { findFilesFromPatterns, generateTimestamp } from './utils';
import { TEMP_EXTENSIONS } from './constants';

const CHANNEL = 'Housekeeping';

export type LatexdiffPackResult =
  | {
      status: 'no-files';
      inputFile: string;
    }
  | {
      status: 'cleaned';
      inputFile: string;
    }
  | {
      status: 'packed';
      inputFile: string;
      outputFolder: string;
    }
  | {
      status: 'processed';
      inputFile: string;
    }
  | {
      status: 'missing-inputs';
    }
  | {
      status: 'error';
      inputFile: string;
      error: unknown;
    };

export async function runPackLatexdiffvc(
  inputFile: string,
  commitHash: string,
  clean: boolean = false,
): Promise<LatexdiffPackResult> {
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
    logger.warn(CHANNEL, 'No LaTeX diff files found to process');
    return { status: 'no-files', inputFile };
  }

  if (clean) {
    for (const file of [...mainFiles, ...tempFiles]) {
      await WorkspaceFS.delete(file);
    }
    logger.info(CHANNEL, 'Cleanup complete.');
    return { status: 'cleaned', inputFile };
  }

  const now = generateTimestamp();
  const outputFolder = path.join(
    inputDir,
    'Diffs',
    `${now}_${baseName}_${commitHash}`,
  );

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
    return { status: 'packed', inputFile, outputFolder };
  }

  return { status: 'processed', inputFile };
}

export async function runPackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean = false,
): Promise<LatexdiffPackResult[]> {
  if (!inputFiles || inputFiles.length === 0) {
    logger.error(
      CHANNEL,
      'No input files provided for multiple LaTeX diff packing',
    );
    return [{ status: 'missing-inputs' }];
  }

  const results: LatexdiffPackResult[] = [];
  for (const inputFile of inputFiles) {
    try {
      results.push(await runPackLatexdiffvc(inputFile, commitHash, clean));
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error during packing ${inputFile}: ${toErrorMessage(err)}`,
      );
      results.push({ status: 'error', inputFile, error: err });
    }
  }
  return results;
}
