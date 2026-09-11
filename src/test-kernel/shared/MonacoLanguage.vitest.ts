import { describe, expect, it } from 'vitest';

// A plain static import is the point of this module: the table must be reachable
// without pulling `monaco-editor` in. If this file ever needs the mocked-Monaco
// harness that MonacoLoader.vitest.ts sets up, the split has regressed.
import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';

describe('monacoLanguageForPath', () => {
  it('maps well-known basenames without an extension to their language id', () => {
    expect(monacoLanguageForPath('Dockerfile')).toBe('dockerfile');
    expect(monacoLanguageForPath('build/Makefile')).toBe('makefile');
  });

  it('reads the extension off the basename, on either separator', () => {
    expect(monacoLanguageForPath('/abs/path/foo.bib')).toBe('bibtex');
    expect(monacoLanguageForPath('windows\\path\\foo.sty')).toBe('latex');
    // A dot in a directory name must not be mistaken for the file's extension.
    expect(monacoLanguageForPath('v1.2/notes.md')).toBe('markdown');
  });

  it('is case-insensitive and falls back to plaintext', () => {
    expect(monacoLanguageForPath('FOO.TEX')).toBe('latex');
    expect(monacoLanguageForPath('Foo.MD')).toBe('markdown');
    expect(monacoLanguageForPath('foo.unknownext')).toBe('plaintext');
    // The desktop diff host passes '' for a diff with no file path.
    expect(monacoLanguageForPath('')).toBe('plaintext');
  });
});
