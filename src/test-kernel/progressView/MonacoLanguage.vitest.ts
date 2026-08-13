// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view helpers
import { getLanguageFromPath } from '@progressView/frontend/formatters/constants';

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
