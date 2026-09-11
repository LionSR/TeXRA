import * as path from 'node:path';

import { createLog } from '@logger/logUtils';
import type { FileOpResult } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { CHANNEL, TEMP_EXTENSIONS } from './constants';
import { collectFilesFromPatterns, generateTimestamp } from './utils';

const log = createLog(CHANNEL);

/**
 * Reuses FileOpResult's `noFiles` and `success` shapes for the outcomes this
 * shares with the housekeeping pack/clean commands (opResults.ts) instead of
 * a parallel status enum, and adds only the two outcomes unique to routing
 * pack and clean through one function: a clean-only run, and a pack run that
 * found nothing but temp files to discard.
 */
export type LatexdiffPackResult =
  | Extract<FileOpResult, { status: 'noFiles' }>
  | Extract<FileOpResult, { status: 'success' }>
  | { status: 'cleaned' }
  | { status: 'processed' };

/** What a host tells the user after a pack or clean run; nothing when the
 *  run only processed files in place. Both hosts read it from here. */
export function latexdiffPackMessage(
  result: LatexdiffPackResult,
): string | undefined {
  switch (result.status) {
    case 'noFiles':
      return 'No LaTeX diff files found to process';
    case 'cleaned':
      return 'LaTeXdiff files cleaned';
    case 'success':
      return result.outputFolder
        ? `Files packed into ${result.outputFolder}`
        : undefined;
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
    return { status: 'noFiles' };
  }

  if (clean) {
    for (const file of [...mainFiles, ...tempFiles]) {
      await WorkspaceFS.delete(file);
    }
    log.info('Cleanup complete.');
    return { status: 'cleaned' };
  }

  // Only temp files matched: delete them and report nothing packed.
  if (mainFiles.size === 0) {
    for (const file of tempFiles) {
      await WorkspaceFS.delete(file);
    }
    return { status: 'processed' };
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
  return { status: 'success', outputFolder };
}
