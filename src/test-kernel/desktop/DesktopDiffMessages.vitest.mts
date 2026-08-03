import { describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.mjs';

describe('monacoLanguageForFilePath', () => {
  it('maps known LaTeX extensions', async () => {
    const { monacoLanguageForFilePath } = await loadSourceModule(
      '@desktop/shared/desktopDiffMessages',
    );
    expect(monacoLanguageForFilePath('foo.tex')).toBe('latex');
    expect(monacoLanguageForFilePath('/abs/path/foo.bib')).toBe('bibtex');
    expect(monacoLanguageForFilePath('windows\\path\\foo.sty')).toBe('latex');
  });

  it('falls back to plaintext on unknown / missing extensions', async () => {
    const { monacoLanguageForFilePath } = await loadSourceModule(
      '@desktop/shared/desktopDiffMessages',
    );
    expect(monacoLanguageForFilePath(undefined)).toBe('plaintext');
    expect(monacoLanguageForFilePath('Makefile')).toBe('plaintext');
    expect(monacoLanguageForFilePath('foo.unknownext')).toBe('plaintext');
  });

  it('is case-insensitive', async () => {
    const { monacoLanguageForFilePath } = await loadSourceModule(
      '@desktop/shared/desktopDiffMessages',
    );
    expect(monacoLanguageForFilePath('FOO.TEX')).toBe('latex');
    expect(monacoLanguageForFilePath('Foo.MD')).toBe('markdown');
  });
});

describe('DesktopShowDiffMessageSchema', () => {
  it('round-trips a complete payload', async () => {
    const { DesktopShowDiffMessageSchema } = await loadSourceModule(
      '@desktop/shared/desktopDiffMessages',
    );
    const parsed = DesktopShowDiffMessageSchema.parse({
      command: 'desktop:showDiff',
      title: 'Compare',
      displayPath: 'src/file.ts',
      originalText: 'a',
      proposedText: 'b',
      additions: 1,
      deletions: 1,
      language: 'latex',
    });
    expect(parsed.command).toBe('desktop:showDiff');
    expect(parsed.language).toBe('latex');
    expect(parsed.displayPath).toBe('src/file.ts');
  });

  it('requires displayPath', async () => {
    const { DesktopShowDiffMessageSchema } = await loadSourceModule(
      '@desktop/shared/desktopDiffMessages',
    );
    const result = DesktopShowDiffMessageSchema.safeParse({
      command: 'desktop:showDiff',
      title: 'Compare',
      originalText: 'a',
      proposedText: 'b',
    });
    expect(result.success).toBe(false);
  });

  it('defaults missing language to plaintext', async () => {
    const { DesktopShowDiffMessageSchema } = await loadSourceModule(
      '@desktop/shared/desktopDiffMessages',
    );
    const parsed = DesktopShowDiffMessageSchema.parse({
      command: 'desktop:showDiff',
      title: 'Compare',
      displayPath: 'src/file.ts',
      originalText: 'a',
      proposedText: 'b',
    });
    expect(parsed.language).toBe('plaintext');
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(0);
  });
});
