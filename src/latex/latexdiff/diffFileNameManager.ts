// Standard library imports
import * as path from 'path';

import {
  extractLastRoundMatch,
  extractLastRoundModelMatch,
} from '@agent/utils/mergeFileUtils';

/** Extract base name from filename using round pattern */
function extractBaseName(filename: string, includeRound: boolean): string {
  const name = path.parse(filename).name;
  const lastMatch = extractLastRoundMatch(name);
  if (lastMatch?.index == null) {
    throw new Error(
      `Failed to extract base name from edited file: ${filename}`,
    );
  }
  // Return everything up to (or including) the last _rN
  // The -1 excludes the trailing underscore from _rN_ when includeRound is true
  const endIndex =
    lastMatch.index + (includeRound ? lastMatch[0].length - 1 : 0);
  return name.slice(0, endIndex);
}

function generateRoundBasedFileName(
  editedFileName: string,
  inputRoundMatch: RegExpMatchArray,
  editedRoundMatch: RegExpMatchArray,
): string {
  const firstRound = inputRoundMatch[1];
  const secondRound = editedRoundMatch[1];
  const sameModel = inputRoundMatch[2] === editedRoundMatch[2];
  const baseName = extractBaseName(editedFileName, sameModel);
  const modelSuffix = sameModel ? `_${editedRoundMatch[2]}` : '';

  return `${baseName}${modelSuffix}_diffr${secondRound}r${firstRound}.tex`;
}

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
  // This distinguishes between-round diffs (r0→r1 in same chain) from
  // round-vs-original diffs (original_r0 → original_r0_agent_r1).
  if (
    inputRoundMatch &&
    editedRoundMatch &&
    inputRoundMatch[1] !== editedRoundMatch[1] &&
    !editedBaseName.startsWith(inputBaseName)
  ) {
    return generateRoundBasedFileName(
      editedFileName,
      inputRoundMatch,
      editedRoundMatch,
    );
  }

  return `${editedBaseName}${suffix}.tex`;
}
