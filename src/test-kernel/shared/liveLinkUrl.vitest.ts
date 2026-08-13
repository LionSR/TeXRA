/**
 * Regression coverage for issue #7230 (follow-up): `sanitizeLiveLinkUrl` must
 * reject root-relative paths, not treat them as safe-as-is. A standalone
 * HTML export opens via `file://` with no origin, so a tool-controlled
 * `/etc/passwd` would resolve against the filesystem root instead of a web
 * origin, becoming a live link to a local file.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeLiveLinkUrl } from '@shared/utils/liveLinkUrl';

describe('sanitizeLiveLinkUrl', () => {
  it.each([
    'https://example.com/page',
    'http://example.com',
    'mailto:a@example.com',
    '#section-2',
  ])('keeps safe URL %s as-is', (url) => {
    expect(sanitizeLiveLinkUrl(url)).toBe(url);
  });

  it.each(['/etc/passwd', '/Users/alice/.ssh/id_rsa', '/local/path'])(
    'rejects root-relative path %s',
    (url) => {
      expect(sanitizeLiveLinkUrl(url)).toBeUndefined();
    },
  );

  it('rejects protocol-relative URLs', () => {
    expect(sanitizeLiveLinkUrl('//evil.example.com/path')).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects dangerous scheme %s', (url) => {
    expect(sanitizeLiveLinkUrl(url)).toBeUndefined();
  });

  it('rejects the empty string', () => {
    expect(sanitizeLiveLinkUrl('')).toBeUndefined();
  });
});
