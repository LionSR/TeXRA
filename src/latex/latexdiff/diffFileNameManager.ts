// Standard library imports
import * as path from 'path';

import {
  extractLastRoundMatch,
  extractLastRoundModelMatch,
} from '@agent/utils/mergeFileUtils';

/**
 * Generate a diff filename based on input and edited file names.
 * Uses round-based naming only for between-round diffs (same operation chain).
 * Falls back to suffix for round-vs-original diffs (edited builds on input).
 */
export function generateDiffFileName(
  inputFile: string,
  editedFile: string,
  suffix: string,
): string {
  const inputFileName = path.basename(inputFile);
  const editedFileName = path.basename(editedFile);
  const inputBaseName = path.parse(inputFileName).name;
  const editedBaseName = path.parse(editedFileName).name;

  const inputRoundMatch = extractLastRoundModelMatch(inputFileName);
  const editedRoundMatch = extractLastRoundModelMatch(editedFileName);

  // Only use round-based naming if:
  // 1. Both files have rounds AND rounds differ
  // 2. The edited file does NOT start with the input file's base name
  //    (if it does, the input's round is part of the base, not a round to diff against)
  // This distinguishes between-round diffs (r0->r1 in same chain) from
  // round-vs-original diffs (original_r0 -> original_r0_agent_r1).
  if (
    inputRoundMatch &&
    editedRoundMatch &&
    inputRoundMatch[1] !== editedRoundMatch[1] &&
    !editedBaseName.startsWith(inputBaseName)
  ) {
    // Generate round-based filename inline
    const firstRound = inputRoundMatch[1];
    const secondRound = editedRoundMatch[1];
    const sameModel = inputRoundMatch[2] === editedRoundMatch[2];

    // Extract base name from edited filename using round pattern
    const name = path.parse(editedFileName).name;
    const lastMatch = extractLastRoundMatch(name);
    if (lastMatch?.index === null || lastMatch?.index === undefined) {
      throw new Error(
        `Failed to extract base name from edited file: ${editedFileName}`,
      );
    }
    // Return everything up to (or including) the last _rN
    // The -1 excludes the trailing underscore from _rN_ when includeRound is true
    const endIndex =
      lastMatch.index + (sameModel ? lastMatch[0].length - 1 : 0);
    const baseName = name.slice(0, endIndex);
    const modelSuffix = sameModel ? `_${editedRoundMatch[2]}` : '';

    return `${baseName}${modelSuffix}_diffr${secondRound}r${firstRound}.tex`;
  }

  return `${editedBaseName}${suffix}.tex`;
}
