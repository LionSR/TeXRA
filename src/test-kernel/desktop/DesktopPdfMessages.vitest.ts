import { beforeAll, describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.ts';

type DesktopPdfMessagesModule =
  typeof import('@desktop/shared/desktopPdfMessages');

describe('desktop PDF messages', () => {
  let DesktopShowPdfMessageSchema: DesktopPdfMessagesModule['DesktopShowPdfMessageSchema'];
  let isSafeAbsolutePdfPath: DesktopPdfMessagesModule['isSafeAbsolutePdfPath'];

  beforeAll(async () => {
    ({ DesktopShowPdfMessageSchema, isSafeAbsolutePdfPath } =
      await loadSourceModule('@desktop/shared/desktopPdfMessages'));
  });

  it('round-trips a complete payload', () => {
    const parsed = DesktopShowPdfMessageSchema.parse({
      command: 'desktop:showPdf',
      title: 'paper.pdf',
      pdfPath: '/abs/path/to/paper.pdf',
    });
    expect(parsed.command).toBe('desktop:showPdf');
    expect(parsed.pdfPath).toBe('/abs/path/to/paper.pdf');
  });

  it('rejects empty pdfPath', () => {
    const result = DesktopShowPdfMessageSchema.safeParse({
      command: 'desktop:showPdf',
      title: 'paper',
      pdfPath: '',
    });
    expect(result.success).toBe(false);
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
