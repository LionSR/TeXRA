import { describe, expect, it } from 'vitest';

// A plain static import is the point of this module: the table must be reachable
// without pulling `monaco-editor` in. If this file ever needs the mocked-Monaco
// harness that MonacoLoader.vitest.ts sets up, the split has regressed.
import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';

describe('monacoLanguageForPath', () => {
  it('maps file extensions to the language ids the loader registers', () => {
    expect(monacoLanguageForPath('paper/main.tex')).toBe('latex');
    expect(monacoLanguageForPath('refs.bib')).toBe('bibtex');
    expect(monacoLanguageForPath('build.py')).toBe('python');
    expect(monacoLanguageForPath('Proof.lean')).toBe('lean');
    // An unknown extension must resolve to a real Monaco id, not undefined —
    // creating a model with an unregistered language throws.
    expect(monacoLanguageForPath('LICENSE')).toBe('plaintext');
  });

  it('maps general-programming extensions to the language ids Monaco bundles', () => {
    expect(monacoLanguageForPath('/workspace/src/index.ts')).toBe('typescript');
    expect(monacoLanguageForPath('src/component.tsx')).toBe('typescript');
    expect(monacoLanguageForPath('scripts/check.mjs')).toBe('javascript');
    expect(monacoLanguageForPath('config/settings.json')).toBe('json');
    expect(monacoLanguageForPath('styles/main.scss')).toBe('scss');
    expect(monacoLanguageForPath('styles/main.less')).toBe('less');
    expect(monacoLanguageForPath('README.md')).toBe('markdown');
    expect(monacoLanguageForPath('docs/guide.mdx')).toBe('mdx');
    expect(monacoLanguageForPath('Main.java')).toBe('java');
    expect(monacoLanguageForPath('Program.cs')).toBe('csharp');
    expect(monacoLanguageForPath('index.php')).toBe('php');
    expect(monacoLanguageForPath('app.rb')).toBe('ruby');
    expect(monacoLanguageForPath('query.sql')).toBe('sql');
    expect(monacoLanguageForPath('data.xml')).toBe('xml');
    expect(monacoLanguageForPath('widget.cxx')).toBe('cpp');
  });

  it('maps well-known basenames without an extension to their language id', () => {
    expect(monacoLanguageForPath('Dockerfile')).toBe('dockerfile');
    expect(monacoLanguageForPath('build/Makefile')).toBe('makefile');
  });
});
