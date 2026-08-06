// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view helpers
import { monacoLanguageForPath } from '@progressView/frontend/components/monacoLanguage';
import { getLanguageFromPath } from '@progressView/frontend/formatters/constants';

describe('monacoLanguageForPath', () => {
  it.each([
    ['/workspace/src/index.ts', 'typescript'],
    ['src/component.tsx', 'typescript'],
    ['scripts/check.mjs', 'javascript'],
    ['config/settings.json', 'json'],
    ['styles/main.scss', 'scss'],
    ['README.md', 'markdown'],
    ['Dockerfile', 'dockerfile'],
    ['Makefile', 'makefile'],
  ])('maps %s to the Monaco language id %s', (path, language) => {
    expect(monacoLanguageForPath(path)).toBe(language);
  });

  it.each([
    ['paper/main.tex', 'plaintext'],
    ['paper/references.bib', 'plaintext'],
    ['notes', 'plaintext'],
    ['', 'plaintext'],
  ])('falls back to %s for %s', (path, language) => {
    expect(monacoLanguageForPath(path)).toBe(language);
  });
});

describe('getLanguageFromPath', () => {
  it.each([
    ['/workspace/Dockerfile', 'dockerfile'],
    ['build/Makefile', 'makefile'],
    ['paper/main.tex', 'latex'],
    ['src/component.unknownext', 'unknownext'],
    ['notes', 'plaintext'],
  ])('maps %s to the highlight id %s', (path, language) => {
    expect(getLanguageFromPath(path)).toBe(language);
  });
});
