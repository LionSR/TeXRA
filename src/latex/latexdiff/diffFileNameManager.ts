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
  if (!lastMatch || lastMatch.index === undefined) {
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

export class DiffFileNameManager {
  generateDiffFileName(
    inputFile: string,
    editedFile: string,
    suffix: string,
  ): string {
    const editedFileName = path.basename(editedFile);
    const inputRoundMatch = extractLastRoundModelMatch(
      path.basename(inputFile),
    );
    const editedRoundMatch = extractLastRoundModelMatch(editedFileName);

    if (inputRoundMatch && editedRoundMatch) {
      return this.generateRoundBasedFileName(
        editedFileName,
        inputRoundMatch,
        editedRoundMatch,
      );
    }

    return `${path.parse(editedFileName).name}${suffix}.tex`;
  }

  private generateRoundBasedFileName(
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
}
