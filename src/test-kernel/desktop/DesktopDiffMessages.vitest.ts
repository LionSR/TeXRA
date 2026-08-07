import { describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.ts';

function loadDesktopDiffMessages() {
  return loadSourceModule('@desktop/shared/desktopDiffMessages');
}

describe('monacoLanguageForFilePath', () => {
  it.each([
    // Known LaTeX extensions.
    ['foo.tex', 'latex'],
    ['/abs/path/foo.bib', 'bibtex'],
    ['windows\\path\\foo.sty', 'latex'],
    // Case-insensitive.
    ['FOO.TEX', 'latex'],
    ['Foo.MD', 'markdown'],
    // Unknown / missing extensions fall back to plaintext.
    [undefined, 'plaintext'],
    ['Makefile', 'plaintext'],
    ['foo.unknownext', 'plaintext'],
  ] as Array<[string | undefined, string]>)(
    'maps %s to %s',
    async (filePath, expected) => {
      const { monacoLanguageForFilePath } = await loadDesktopDiffMessages();
      expect(monacoLanguageForFilePath(filePath)).toBe(expected);
    },
  );
});

describe('DesktopShowDiffMessageSchema', () => {
  const basePayload = {
    command: 'desktop:showDiff',
    title: 'Compare',
    originalText: 'a',
    proposedText: 'b',
  } as const;

  it('round-trips a complete payload', async () => {
    const { DesktopShowDiffMessageSchema } = await loadDesktopDiffMessages();
    const parsed = DesktopShowDiffMessageSchema.parse({
      ...basePayload,
      displayPath: 'src/file.ts',
      additions: 1,
      deletions: 1,
      language: 'latex',
    });
    expect(parsed.command).toBe('desktop:showDiff');
    expect(parsed.language).toBe('latex');
    expect(parsed.displayPath).toBe('src/file.ts');
  });

  it('requires displayPath', async () => {
    const { DesktopShowDiffMessageSchema } = await loadDesktopDiffMessages();
    const result = DesktopShowDiffMessageSchema.safeParse(basePayload);
    expect(result.success).toBe(false);
  });

  it('defaults missing language to plaintext', async () => {
    const { DesktopShowDiffMessageSchema } = await loadDesktopDiffMessages();
    const parsed = DesktopShowDiffMessageSchema.parse({
      ...basePayload,
      displayPath: 'src/file.ts',
    });
    expect(parsed.language).toBe('plaintext');
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(0);
  });
});
