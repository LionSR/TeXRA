// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view helpers
import { monacoLanguageForPath } from '@progressView/frontend/components/monacoLanguage';

describe('monacoLanguageForPath', () => {
  it('maps common source file extensions to Monaco language ids', () => {
    expect(monacoLanguageForPath('/workspace/src/index.ts')).toBe('typescript');
    expect(monacoLanguageForPath('src/component.tsx')).toBe('typescript');
    expect(monacoLanguageForPath('scripts/check.mjs')).toBe('javascript');
    expect(monacoLanguageForPath('config/settings.json')).toBe('json');
    expect(monacoLanguageForPath('styles/main.scss')).toBe('scss');
    expect(monacoLanguageForPath('README.md')).toBe('markdown');
    expect(monacoLanguageForPath('Dockerfile')).toBe('dockerfile');
  });

  it('falls back to plaintext for unregistered or unknown extensions', () => {
    expect(monacoLanguageForPath('paper/main.tex')).toBe('plaintext');
    expect(monacoLanguageForPath('paper/references.bib')).toBe('plaintext');
    expect(monacoLanguageForPath('notes')).toBe('plaintext');
    expect(monacoLanguageForPath('')).toBe('plaintext');
  });
});
