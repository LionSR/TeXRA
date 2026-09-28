import { describe, expect, it } from 'vitest';

import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';

describe('monacoLanguageForPath (src/shared/monaco/monacoLanguage.ts)', () => {
  it('maps known extensions to their Monaco language id', () => {
    expect(monacoLanguageForPath('paper.tex')).toBe('latex');
    expect(monacoLanguageForPath('C:\\repo\\src\\index.ts')).toBe('typescript');
  });

  it('recognizes Dockerfile and Makefile by basename, case-insensitively', () => {
    expect(monacoLanguageForPath('/workspace/Dockerfile')).toBe('dockerfile');
    expect(monacoLanguageForPath('/workspace/makefile')).toBe('makefile');
  });

  // Regression: the hand-rolled `split('/').at(-1)` this used to run returned
  // '' for a trailing-slash path, so a directory-shaped input misclassified
  // as plaintext instead of resolving to its basename. Now routed through the
  // shared `getBasename` (@utils/core), which strips the trailing slash.
  it('resolves the basename through a trailing slash', () => {
    expect(monacoLanguageForPath('/workspace/Dockerfile/')).toBe('dockerfile');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(monacoLanguageForPath('notes.xyz')).toBe('plaintext');
  });
});
