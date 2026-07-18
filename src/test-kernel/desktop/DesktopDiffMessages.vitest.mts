import { describe, expect, it } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

async function loadDiffMessages(): Promise<
  typeof import('../../../packages/desktop/src/desktopDiffMessages')
> {
  return (await import(
    moduleFileUrl(desktopSourcePath('desktopDiffMessages.ts'))
  )) as typeof import('../../../packages/desktop/src/desktopDiffMessages');
}

describe('monacoLanguageForFilePath', () => {
  it('maps known LaTeX extensions', async () => {
    const { monacoLanguageForFilePath } = await loadDiffMessages();
    expect(monacoLanguageForFilePath('foo.tex')).toBe('latex');
    expect(monacoLanguageForFilePath('/abs/path/foo.bib')).toBe('bibtex');
    expect(monacoLanguageForFilePath('windows\\path\\foo.sty')).toBe('latex');
  });

  it('falls back to plaintext on unknown / missing extensions', async () => {
    const { monacoLanguageForFilePath } = await loadDiffMessages();
    expect(monacoLanguageForFilePath(undefined)).toBe('plaintext');
    expect(monacoLanguageForFilePath('Makefile')).toBe('plaintext');
    expect(monacoLanguageForFilePath('foo.unknownext')).toBe('plaintext');
  });

  it('is case-insensitive', async () => {
    const { monacoLanguageForFilePath } = await loadDiffMessages();
    expect(monacoLanguageForFilePath('FOO.TEX')).toBe('latex');
    expect(monacoLanguageForFilePath('Foo.MD')).toBe('markdown');
  });
});

describe('DesktopShowDiffMessageSchema', () => {
  it('round-trips a complete payload', async () => {
    const { DesktopShowDiffMessageSchema } = await loadDiffMessages();
    const parsed = DesktopShowDiffMessageSchema.parse({
      command: 'desktop:showDiff',
      title: 'Compare',
      originalText: 'a',
      proposedText: 'b',
      language: 'latex',
      originalPath: '/a',
      proposedPath: '/b',
    });
    expect(parsed.command).toBe('desktop:showDiff');
    expect(parsed.language).toBe('latex');
  });

  it('defaults missing language to plaintext', async () => {
    const { DesktopShowDiffMessageSchema } = await loadDiffMessages();
    const parsed = DesktopShowDiffMessageSchema.parse({
      command: 'desktop:showDiff',
      title: 'Compare',
      originalText: 'a',
      proposedText: 'b',
    });
    expect(parsed.language).toBe('plaintext');
  });
});
