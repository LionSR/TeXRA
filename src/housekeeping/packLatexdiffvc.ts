import * as path from 'node:path';

import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { WorkspaceFs } from '@platform/rootedFs';
import type { FileOpResult } from '@shared/schemas';

import { CHANNEL, TEMP_EXTENSIONS } from './constants';
import { collectFilesFromPatterns, generateTimestamp } from './utils';

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

export const runPackLatexdiffvc = Effect.fn('housekeeping.packLatexdiffvc')(
  function* (inputFile: string, commitHash: string, clean: boolean = false) {
    const workspaceFs = yield* WorkspaceFs;
    const workspaceRoot = workspaceFs.root;
    if (!workspaceRoot) {
      return { status: 'noFiles' } satisfies LatexdiffPackResult;
    }

    const baseName = path.parse(inputFile).name;
    const inputDir = path.dirname(inputFile);
    const filePatterns = [`${baseName}-diff${commitHash}`];

    const mainFiles = yield* collectFilesFromPatterns(
      workspaceRoot,
      inputDir,
      filePatterns,
      ['.tex', '.pdf'],
    );
    const tempFiles = yield* collectFilesFromPatterns(
      workspaceRoot,
      inputDir,
      filePatterns,
      TEMP_EXTENSIONS,
    );

    /** `force`: the sweep tolerates a file a sibling host already removed. */
    const discard = (files: Iterable<string>) =>
      Effect.forEach(files, (file) =>
        workspaceFs.remove(file, { force: true }),
      );

    if (mainFiles.size === 0 && tempFiles.size === 0) {
      yield* Effect.logWarning('No LaTeX diff files found to process').pipe(
        withLogChannel(CHANNEL),
      );
      return { status: 'noFiles' } satisfies LatexdiffPackResult;
    }

    if (clean) {
      yield* discard([...mainFiles, ...tempFiles]);
      yield* Effect.logInfo('Cleanup complete.').pipe(withLogChannel(CHANNEL));
      return { status: 'cleaned' } satisfies LatexdiffPackResult;
    }

    // Only temp files matched: delete them and report nothing packed.
    if (mainFiles.size === 0) {
      yield* discard(tempFiles);
      return { status: 'processed' } satisfies LatexdiffPackResult;
    }

    const outputFolder = path.join(
      inputDir,
      'Diffs',
      `${generateTimestamp()}_${baseName}_${commitHash}`,
    );

    yield* workspaceFs.makeDirectory(outputFolder, { recursive: true });
    for (const file of mainFiles) {
      yield* workspaceFs.rename(
        file,
        path.join(outputFolder, path.basename(file)),
      );
    }

    yield* discard(tempFiles);

    yield* Effect.logInfo(`Files packed into ${outputFolder}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { status: 'success', outputFolder } satisfies LatexdiffPackResult;
  },
);
