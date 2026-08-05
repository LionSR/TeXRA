// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view helpers
import { monacoLanguageForPath } from '@progressView/frontend/components/monacoLanguage';
import { getLanguageFromPath } from '@progressView/frontend/formatters/constants';

describe('monacoLanguageForPath', () => {
  it('maps common source file extensions to Monaco language ids', () => {
    expect(monacoLanguageForPath('/workspace/src/index.ts')).toBe('typescript');
    expect(monacoLanguageForPath('src/component.tsx')).toBe('typescript');
    expect(monacoLanguageForPath('scripts/check.mjs')).toBe('javascript');
    expect(monacoLanguageForPath('config/settings.json')).toBe('json');
    expect(monacoLanguageForPath('styles/main.scss')).toBe('scss');
    expect(monacoLanguageForPath('README.md')).toBe('markdown');
    expect(monacoLanguageForPath('Dockerfile')).toBe('dockerfile');
    expect(monacoLanguageForPath('Makefile')).toBe('makefile');
  });

  it('falls back to plaintext for unregistered or unknown extensions', () => {
    expect(monacoLanguageForPath('paper/main.tex')).toBe('plaintext');
    expect(monacoLanguageForPath('paper/references.bib')).toBe('plaintext');
    expect(monacoLanguageForPath('notes')).toBe('plaintext');
    expect(monacoLanguageForPath('')).toBe('plaintext');
  });
});

describe('getLanguageFromPath', () => {
  it('uses the shared path parsing and basename logic for highlight ids', () => {
    expect(getLanguageFromPath('/workspace/Dockerfile')).toBe('dockerfile');
    expect(getLanguageFromPath('build/Makefile')).toBe('makefile');
    expect(getLanguageFromPath('paper/main.tex')).toBe('latex');
    expect(getLanguageFromPath('src/component.unknownext')).toBe('unknownext');
    expect(getLanguageFromPath('notes')).toBe('plaintext');
  });
});
