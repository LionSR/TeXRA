import { describe, expect, it } from 'vitest';

import { normalizeLatexPath, toPosixPath } from '@utils/core/pathCore';

describe('pathCore', () => {
  describe('toPosixPath', () => {
    it('converts backslashes and collapses duplicate separators', () => {
      expect(toPosixPath(String.raw`sections\\intro`)).toBe('sections/intro');
      expect(toPosixPath('sections//intro')).toBe('sections/intro');
      expect(toPosixPath(String.raw`sections\/intro`)).toBe('sections/intro');
    });

    it('strips leading and trailing separators', () => {
      expect(toPosixPath('/sections/intro/')).toBe('sections/intro');
      expect(toPosixPath('\\sections\\intro\\')).toBe('sections/intro');
    });
  });

  describe('normalizeLatexPath', () => {
    it('normalizes redundant separators before removing leading dot segments', () => {
      expect(normalizeLatexPath('.//sections//intro')).toBe('sections/intro');
      expect(normalizeLatexPath(String.raw`.\\sections\\intro`)).toBe(
        'sections/intro',
      );
    });
  });
});
