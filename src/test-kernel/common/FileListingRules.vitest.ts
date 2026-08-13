import { describe, expect, it } from 'vitest';

import {
  getFileListConfig,
  loadFileListSettings,
  matchesEditedFile,
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
} from '@common/files/fileListingRules';

describe('shared file-listing rules', () => {
  it('builds input configs from the product file-handling rules', () => {
    const settings = loadFileListSettings();

    const config = getFileListConfig('input', settings);

    expect(config).toMatchObject({
      extensions: ['.txt', '.tex', '.md'],
      ignoredFiles: ['command.tex', 'commands.tex', 'preamble.tex', 'yaml'],
    });
    expect(config?.ignoredDirs).toContain('node_modules');
  });

  it('normalizes filters once and applies file and directory rules', () => {
    const filters = prepareFileFilters({
      extensions: ['.TEX'],
      ignoredExtensions: ['.PDF'],
      ignoredDirs: ['node_modules', 'drafts/generated'],
      ignoredKeywords: ['scratch', 'template'],
      ignoredFiles: ['command.tex'],
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

  it('matches edited files with shared round-suffix base-name logic', () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ['sections/main_edited.tex', 'main.tex', true],
      ['sections/main_r1.tex', 'main.tex', true],
      ['sections/main_r3.tex', 'main_r2.tex', true],
      ['main.tex', 'main.tex', false],
      ['sections/other.tex', 'main.tex', false],
    ];
    for (const [edited, original, expected] of cases) {
      expect(matchesEditedFile(edited, original)).toBe(expected);
    }
  });
});
