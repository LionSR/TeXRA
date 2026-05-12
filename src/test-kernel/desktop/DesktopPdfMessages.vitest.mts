import { describe, expect, it } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

async function loadPdfMessages(): Promise<
  typeof import('../../../packages/desktop/src/desktopPdfMessages')
> {
  return (await import(
    moduleFileUrl(desktopSourcePath('desktopPdfMessages.ts'))
  )) as typeof import('../../../packages/desktop/src/desktopPdfMessages');
}

describe('DesktopShowPdfMessageSchema', () => {
  it('round-trips a complete payload', async () => {
    const { DesktopShowPdfMessageSchema, buildDesktopShowPdfMessage } =
      await loadPdfMessages();
    const message = buildDesktopShowPdfMessage({
      title: 'paper.pdf',
      pdfPath: '/abs/path/to/paper.pdf',
    });
    const parsed = DesktopShowPdfMessageSchema.parse(message);
    expect(parsed.command).toBe('desktop:showPdf');
    expect(parsed.pdfPath).toBe('/abs/path/to/paper.pdf');
  });

  it('rejects empty pdfPath', async () => {
    const { DesktopShowPdfMessageSchema } = await loadPdfMessages();
    const result = DesktopShowPdfMessageSchema.safeParse({
      command: 'desktop:showPdf',
      title: 'paper',
      pdfPath: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('isSafeAbsolutePdfPath', () => {
  it('accepts posix absolute PDF paths', async () => {
    const { isSafeAbsolutePdfPath } = await loadPdfMessages();
    expect(isSafeAbsolutePdfPath('/Users/me/paper.pdf')).toBe(true);
    expect(isSafeAbsolutePdfPath('/tmp/build/output.PDF')).toBe(true);
  });

  it('accepts Windows drive-letter and UNC absolute PDF paths', async () => {
    const { isSafeAbsolutePdfPath } = await loadPdfMessages();
    expect(isSafeAbsolutePdfPath('C:\\Users\\me\\paper.pdf')).toBe(true);
    expect(isSafeAbsolutePdfPath('C:/Users/me/paper.pdf')).toBe(true);
    expect(isSafeAbsolutePdfPath('\\\\server\\share\\paper.pdf')).toBe(true);
  });

  it('rejects URL-scheme prefixes', async () => {
    const { isSafeAbsolutePdfPath } = await loadPdfMessages();
    expect(isSafeAbsolutePdfPath('http://evil.com/x.pdf')).toBe(false);
    expect(isSafeAbsolutePdfPath('https://evil.com/x.pdf')).toBe(false);
    expect(isSafeAbsolutePdfPath('javascript:alert(1)')).toBe(false);
    expect(isSafeAbsolutePdfPath('data:application/pdf,abc')).toBe(false);
    // Even `file:` is rejected — the renderer prepends `file://` itself.
    expect(isSafeAbsolutePdfPath('file:///tmp/x.pdf')).toBe(false);
  });

  it('rejects relative paths and non-PDF extensions', async () => {
    const { isSafeAbsolutePdfPath } = await loadPdfMessages();
    expect(isSafeAbsolutePdfPath('relative/path.pdf')).toBe(false);
    expect(isSafeAbsolutePdfPath('./paper.pdf')).toBe(false);
    expect(isSafeAbsolutePdfPath('/tmp/script.js')).toBe(false);
    expect(isSafeAbsolutePdfPath('/tmp/no-extension')).toBe(false);
  });

  it('rejects empty / whitespace-padded strings', async () => {
    const { isSafeAbsolutePdfPath } = await loadPdfMessages();
    expect(isSafeAbsolutePdfPath('')).toBe(false);
    expect(isSafeAbsolutePdfPath('  /tmp/x.pdf  ')).toBe(false);
  });
});
