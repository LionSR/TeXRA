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
  it('keeps safe absolute URLs', () => {
    expect(sanitizeLiveLinkUrl('https://example.com/page')).toBe(
      'https://example.com/page',
    );
    expect(sanitizeLiveLinkUrl('http://example.com')).toBe(
      'http://example.com',
    );
    expect(sanitizeLiveLinkUrl('mailto:a@example.com')).toBe(
      'mailto:a@example.com',
    );
  });

  it('keeps anchor-only fragments', () => {
    expect(sanitizeLiveLinkUrl('#section-2')).toBe('#section-2');
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
