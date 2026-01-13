// Standard library imports
import * as path from 'path';

import { extractLastRoundMatch } from '@agent/utils/mergeFileUtils';

/** Extract base name from filename using round pattern */
function extractBaseName(filename: string, includeRound: boolean): string {
  const name = path.parse(filename).name;
  const lastMatch = extractLastRoundMatch(name);
  if (!lastMatch || lastMatch.index === undefined) {
    throw new Error('Failed to extract base name from edited file');
  }
  // Return everything up to (or including) the last _rN
  // The -1 excludes the trailing underscore from _rN_ when includeRound is true
  return includeRound
    ? name.slice(0, lastMatch.index + lastMatch[0].length - 1)
    : name.slice(0, lastMatch.index);
}

export class DiffFileNameManager {
  generateDiffFileName(
    inputFile: string,
    editedFile: string,
    suffix: string,
  ): string {
    const editedFileName = path.basename(editedFile);
    // Find the LAST _rN_ pattern (base filename may contain its own _rN_)
    // Use [^_.]+ to stop at underscores, allowing multiple matches
    const inputMatches = [...path.basename(inputFile).matchAll(/_r(\d+)_([^_.]+)/g)];
    const editedMatches = [...editedFileName.matchAll(/_r(\d+)_([^_.]+)/g)];
    const inputRoundMatch = inputMatches.at(-1);
    const editedRoundMatch = editedMatches.at(-1);

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
    const firstModel = inputRoundMatch[2];
    const secondModel = editedRoundMatch[2];

    const sameModel = firstModel === secondModel;
    const baseName = extractBaseName(editedFileName, sameModel);

    return sameModel
      ? `${baseName}_${secondModel}_diffr${secondRound}r${firstRound}.tex`
      : `${baseName}_diffr${secondRound}r${firstRound}.tex`;
  }
}
