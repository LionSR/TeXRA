import * as path from 'node:path';

import { createLog } from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { CHANNEL, TEMP_EXTENSIONS } from './constants';
import { collectFilesFromPatterns, generateTimestamp } from './utils';

const log = createLog(CHANNEL);

export type LatexdiffPackResult =
  | {
      status: 'no-files' | 'cleaned' | 'processed';
      inputFile: string;
    }
  | {
      status: 'packed';
      inputFile: string;
      outputFolder: string;
    };

/** What a host tells the user after a pack or clean run; nothing when the
 *  run only processed files in place. Both hosts read it from here. */
export function latexdiffPackMessage(
  result: LatexdiffPackResult,
): string | undefined {
  switch (result.status) {
    case 'no-files':
      return 'No LaTeX diff files found to process';
    case 'cleaned':
      return 'LaTeXdiff files cleaned';
    case 'packed':
      return `Files packed into ${result.outputFolder}`;
    case 'processed':
      return undefined;
  }
}

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

  // Only temp files matched: delete them and report nothing packed.
  if (mainFiles.size === 0) {
    for (const file of tempFiles) {
      await WorkspaceFS.delete(file);
    }
    return { status: 'processed', inputFile };
  }

  const outputFolder = path.join(
    inputDir,
    'Diffs',
    `${generateTimestamp()}_${baseName}_${commitHash}`,
  );

  await WorkspaceFS.createDir(outputFolder);
  for (const file of mainFiles) {
    await WorkspaceFS.rename(
      file,
      path.join(outputFolder, path.basename(file)),
    );
  }

  for (const file of tempFiles) {
    await WorkspaceFS.delete(file);
  }

  log.info(`Files packed into ${outputFolder}`);
  return { status: 'packed', inputFile, outputFolder };
}
