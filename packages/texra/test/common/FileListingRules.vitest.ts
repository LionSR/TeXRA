import { describe, expect, it } from 'vitest';

import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
} from '@texra/common/files/fileListingRules';

describe('shared file-listing rules', () => {
  it('normalizes filters once and applies file and directory rules', () => {
    const filters = prepareFileFilters({
      include: ['.TEX'],
      excludeExtensions: ['.PDF'],
      excludeDirs: ['node_modules', 'drafts/generated'],
      excludeKeywords: ['scratch', 'template'],
      excludeFiles: ['command.tex'],
    });

    const directoryCases: ReadonlyArray<readonly [string, boolean]> = [
      ['sections', true],
      ['node_modules/pkg', false],
      ['drafts/generated', false],
    ];
    for (const [directory, expected] of directoryCases) {
      expect(shouldVisitDirectory(directory, filters)).toBe(expected);
    }

    const fileCases: ReadonlyArray<readonly [string, boolean]> = [
      ['sections/main.tex', true],
      ['command.tex', false],
      ['sections/main.pdf', false],
      ['sections/scratch-notes.tex', false],
      ['templates/main.tex', true],
      ['.cache/main.tex', false],
    ];
    for (const [file, expected] of fileCases) {
      expect(passesFileFilters(file, filters)).toBe(expected);
    }
  });
});
