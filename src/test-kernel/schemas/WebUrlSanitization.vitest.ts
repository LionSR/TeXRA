/**
 * Regression coverage for issue #7230: `web_search`/`web_fetch` `url` fields
 * are LLM/tool-controlled and must never carry a dangerous scheme through to
 * a rendered `<a href>` — in the live Progress View webview OR the exported
 * standalone HTML (which has no CSP). The sanitization lives at the schema
 * level (`WebSearchResultItemSchema` / `WebFetchPayloadSchema` in
 * `src/shared/schemas/progressView/data.ts`) so both render paths, which
 * share the same formatters, are protected by one fix.
 *
 * Expected behavior mirrors the retired hand-written HTML exporter's
 * `safeUrl()` (deleted with `formatChatAsHtml` in #7137 — see
 * `git log -p -S SAFE_URL_SCHEMES`): only `http:`/`https:`/`mailto:` survive
 * scheme validation; anchor-only (`#foo`) and root-relative (`/foo`, not
 * `//foo`) URLs pass through unchecked since there's no scheme to abuse;
 * everything else (empty, unparseable, protocol-relative, dangerous scheme)
 * collapses to `undefined`.
 */
import { describe, expect, it } from 'vitest';

import { WebFetchPayloadSchema, WebSearchPayloadSchema } from '@shared/schemas';

function parseSearchUrl(url: string): string | undefined {
  return WebSearchPayloadSchema.parse({
    results: [{ url, title: 'result' }],
  }).results?.[0]?.url;
}

function parseFetchUrl(url: string): string | undefined {
  return WebFetchPayloadSchema.parse({ url }).url;
}

describe('web tool URL sanitization (issue #7230)', () => {
  describe('dangerous schemes are stripped', () => {
    const dangerous = [
      'javascript:alert(1)',
      'javascript:alert(document.cookie)',
      'JavaScript:alert(1)', // scheme match must not be case-sensitive-bypassable
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '  javascript:alert(1)', // leading whitespace shouldn't bypass the scheme check
      'javascript:alert(1)  ', // trailing whitespace likewise
    ];

    it.each(dangerous)('strips %s from web_search results', (url) => {
      expect(parseSearchUrl(url)).toBeUndefined();
    });

    it.each(dangerous)('strips %s from web_fetch payloads', (url) => {
      expect(parseFetchUrl(url)).toBeUndefined();
    });
  });

  it('strips protocol-relative URLs (no scheme to validate against)', () => {
    expect(parseSearchUrl('//evil.example.com/path')).toBeUndefined();
    expect(parseFetchUrl('//evil.example.com/path')).toBeUndefined();
  });

  it('strips the empty string', () => {
    expect(parseSearchUrl('')).toBeUndefined();
    expect(parseFetchUrl('')).toBeUndefined();
  });

  it('strips whitespace-only URLs', () => {
    expect(parseSearchUrl('   ')).toBeUndefined();
  });

  describe('legitimate URLs still render', () => {
    const safe = [
      'http://example.com',
      'https://example.com/path?query=1#frag',
      'mailto:someone@example.com',
      'https://sub.example.co.uk:8443/a/b?c=d&e=f',
      '  https://example.com/padded  ', // whitespace-padded but otherwise safe
    ];

    it.each(safe)('keeps %s as a live href for web_search', (url) => {
      expect(parseSearchUrl(url)).toBe(url.trim());
    });

    it.each(safe)('keeps %s as a live href for web_fetch', (url) => {
      expect(parseFetchUrl(url)).toBe(url.trim());
    });
  });

  it('keeps anchor-only fragments as-is', () => {
    expect(parseSearchUrl('#section-2')).toBe('#section-2');
  });

  it('keeps root-relative paths as-is', () => {
    expect(parseSearchUrl('/local/path')).toBe('/local/path');
  });

  it('sanitizes each item independently in a mixed results list', () => {
    const parsed = WebSearchPayloadSchema.parse({
      results: [
        { url: 'javascript:alert(1)', title: 'evil' },
        { url: 'https://example.com', title: 'safe' },
      ],
    });

    expect(parsed.results?.[0]?.url).toBeUndefined();
    expect(parsed.results?.[1]?.url).toBe('https://example.com');
  });

  it('leaves a missing url as undefined without throwing', () => {
    expect(WebSearchPayloadSchema.parse({}).results).toBeUndefined();
    expect(WebFetchPayloadSchema.parse({}).url).toBeUndefined();
  });
});
