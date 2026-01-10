// Standard library imports
import * as path from 'path';

/** Extract base name from filename using round pattern */
function extractBaseName(filename: string, includeRound: boolean): string {
  const pattern = includeRound ? /^(.*?_r\d+)/ : /^(.*?)_r\d+/;
  const match = path.parse(filename).name.match(pattern);
  if (!match) {
    throw new Error('Failed to extract base name from edited file');
  }
  return match[1];
}

export class DiffFileNameManager {
  generateDiffFileName(
    inputFile: string,
    editedFile: string,
    suffix: string,
  ): string {
    const editedFileName = path.basename(editedFile);
    const inputRoundMatch = path.basename(inputFile).match(/_r(\d+)_([^.]+)/);
    const editedRoundMatch = editedFileName.match(/_r(\d+)_([^.]+)/);

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
