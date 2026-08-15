import * as path from 'node:path';

import { createLog } from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { CHANNEL, TEMP_EXTENSIONS } from './constants';
import { collectFilesFromPatterns, generateTimestamp } from './utils';

const log = createLog(CHANNEL);

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
    };

export async function runPackLatexdiffvc(
  inputFile: string,
  commitHash: string,
  clean: boolean = false,
): Promise<LatexdiffPackResult> {
  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  const filePatterns = [`${baseName}-diff${commitHash}`];

  const mainFiles = await collectFilesFromPatterns(inputDir, filePatterns, [
    '.tex',
    '.pdf',
  ]);
  const tempFiles = await collectFilesFromPatterns(
    inputDir,
    filePatterns,
    TEMP_EXTENSIONS,
  );

  if (mainFiles.size === 0 && tempFiles.size === 0) {
    log.warn('No LaTeX diff files found to process');
    return { status: 'no-files', inputFile };
  }

  if (clean) {
    for (const file of [...mainFiles, ...tempFiles]) {
      await WorkspaceFS.delete(file);
    }
    log.info('Cleanup complete.');
    return { status: 'cleaned', inputFile };
  }

  const now = generateTimestamp();
  const outputFolder = path.join(
    inputDir,
    'Diffs',
    `${now}_${baseName}_${commitHash}`,
  );

  if (mainFiles.size > 0) {
    await WorkspaceFS.createDir(outputFolder);
    for (const file of mainFiles) {
      await WorkspaceFS.rename(
        file,
        path.join(outputFolder, path.basename(file)),
      );
    }
  }

  for (const file of tempFiles) {
    await WorkspaceFS.delete(file);
  }

  if (mainFiles.size > 0) {
    log.info(`Files packed into ${outputFolder}`);
    return { status: 'packed', inputFile, outputFolder };
  }

  return { status: 'processed', inputFile };
}
