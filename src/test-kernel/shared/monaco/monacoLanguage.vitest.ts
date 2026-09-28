import { describe, expect, it } from 'vitest';

import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';

describe('monacoLanguageForPath (src/shared/monaco/monacoLanguage.ts)', () => {
  // Regression: the hand-rolled `split('/').at(-1)` this used to run returned
  // '' for a trailing-slash path, so a directory-shaped input misclassified
  // as plaintext instead of resolving to its basename. Now routed through the
  // shared `getBasename` (@utils/core), which strips the trailing slash.
  it('resolves the basename through a trailing slash', () => {
    expect(monacoLanguageForPath('/workspace/Dockerfile/')).toBe('dockerfile');
  });
});
