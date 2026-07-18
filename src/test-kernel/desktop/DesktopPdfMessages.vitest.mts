import { beforeAll, describe, expect, it } from 'vitest';

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
    const { DesktopShowPdfMessageSchema } = await loadPdfMessages();
    const parsed = DesktopShowPdfMessageSchema.parse({
      command: 'desktop:showPdf',
      title: 'paper.pdf',
      pdfPath: '/abs/path/to/paper.pdf',
    });
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
  let isSafeAbsolutePdfPath: (path: string) => boolean;
  beforeAll(async () => {
    ({ isSafeAbsolutePdfPath } = await loadPdfMessages());
  });

  it.each<[string, boolean]>([
    // posix absolute PDF paths
    ['/Users/me/paper.pdf', true],
    ['/tmp/build/output.PDF', true],
    // Windows drive-letter and UNC absolute PDF paths
    ['C:\\Users\\me\\paper.pdf', true],
    ['C:/Users/me/paper.pdf', true],
    ['\\\\server\\share\\paper.pdf', true],
    // URL-scheme prefixes
    ['http://evil.com/x.pdf', false],
    ['https://evil.com/x.pdf', false],
    ['javascript:alert(1)', false],
    ['data:application/pdf,abc', false],
    // Even `file:` is rejected — the renderer prepends `file://` itself.
    ['file:///tmp/x.pdf', false],
    // relative paths and non-PDF extensions
    ['relative/path.pdf', false],
    ['./paper.pdf', false],
    ['/tmp/script.js', false],
    ['/tmp/no-extension', false],
    // empty / whitespace-padded strings
    ['', false],
    ['  /tmp/x.pdf  ', false],
  ])('%j -> %s', (input, expected) => {
    expect(isSafeAbsolutePdfPath(input)).toBe(expected);
  });
});
