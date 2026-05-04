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
  it('builds input configs from shared include and ignore settings', () => {
    const settings = loadFileListSettings((key, fallback) => {
      if (key === 'texra.files.ignored.inputDirectories') {
        return ['drafts'] as typeof fallback;
      }
      return fallback;
    });

    const config = getFileListConfig('input', settings);

    expect(config).toMatchObject({
      extensions: ['.txt', '.tex', '.md'],
      ignoredFiles: ['command.tex', 'commands.tex', 'preamble.tex', 'yaml'],
    });
    expect(config?.ignoredDirs).toContain('node_modules');
    expect(config?.ignoredDirs).toContain('drafts');
  });

  it('normalizes filters once and applies file and directory rules', () => {
    const filters = prepareFileFilters({
      extensions: ['.TEX'],
      ignoredExtensions: ['.PDF'],
      ignoredDirs: ['node_modules', 'drafts/generated'],
      ignoredKeywords: ['scratch', 'template'],
      ignoredFiles: ['command.tex'],
    });

    expect(shouldVisitDirectory('sections', filters)).toBe(true);
    expect(shouldVisitDirectory('node_modules/pkg', filters)).toBe(false);
    expect(shouldVisitDirectory('drafts/generated', filters)).toBe(false);
    expect(passesFileFilters('sections/main.tex', filters)).toBe(true);
    expect(passesFileFilters('command.tex', filters)).toBe(false);
    expect(passesFileFilters('sections/main.pdf', filters)).toBe(false);
    expect(passesFileFilters('sections/scratch-notes.tex', filters)).toBe(
      false,
    );
    expect(passesFileFilters('templates/main.tex', filters)).toBe(true);
    expect(passesFileFilters('.cache/main.tex', filters)).toBe(false);
  });

  it('matches edited files with shared round-suffix base-name logic', () => {
    expect(matchesEditedFile('sections/main_edited.tex', 'main.tex')).toBe(
      true,
    );
    expect(matchesEditedFile('sections/main_r1.tex', 'main.tex')).toBe(true);
    expect(matchesEditedFile('sections/main_r3.tex', 'main_r2.tex')).toBe(true);
    expect(matchesEditedFile('main.tex', 'main.tex')).toBe(false);
    expect(matchesEditedFile('sections/other.tex', 'main.tex')).toBe(false);
  });
});
