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
 * Uses round-based naming if both files have rounds AND rounds differ.
 */
export function generateDiffFileName(
  inputFile: string,
  editedFile: string,
  suffix: string,
): string {
  const editedFileName = path.basename(editedFile);
  const inputRoundMatch = extractLastRoundModelMatch(path.basename(inputFile));
  const editedRoundMatch = extractLastRoundModelMatch(editedFileName);

  // Only use round-based naming if both files have rounds AND rounds differ.
  // Same-round comparisons (e.g., original vs proposed temp files) fall back to suffix.
  if (
    inputRoundMatch &&
    editedRoundMatch &&
    inputRoundMatch[1] !== editedRoundMatch[1]
  ) {
    return generateRoundBasedFileName(
      editedFileName,
      inputRoundMatch,
      editedRoundMatch,
    );
  }

  return `${path.parse(editedFileName).name}${suffix}.tex`;
}
