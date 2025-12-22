// Standard library imports
import * as path from 'path';

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
        inputFile,
        editedFile,
        inputRoundMatch,
        editedRoundMatch,
      );
    }

    return `${path.parse(editedFileName).name}${suffix}.tex`;
  }

  private generateRoundBasedFileName(
    _inputFile: string,
    editedFile: string,
    inputRoundMatch: RegExpMatchArray,
    editedRoundMatch: RegExpMatchArray,
  ): string {
    const firstRound = inputRoundMatch[1];
    const secondRound = editedRoundMatch[1];
    const firstModel = inputRoundMatch[2];
    const secondModel = editedRoundMatch[2];
    const editedFileName = path.basename(editedFile);

    if (firstModel === secondModel) {
      const baseNameMatch = path
        .parse(editedFileName)
        .name.match(/^(.*?_r\d+)/);
      if (!baseNameMatch) {
        throw new Error('Failed to extract base name from edited file');
      }
      return `${baseNameMatch[1]}_${secondModel}_diffr${secondRound}r${firstRound}.tex`;
    } else {
      const baseNameMatch = path
        .parse(editedFileName)
        .name.match(/^(.*?)_r\d+/);
      if (!baseNameMatch) {
        throw new Error('Failed to extract base name from edited file');
      }
      return `${baseNameMatch[1]}_diffr${secondRound}r${firstRound}.tex`;
    }
  }
}
