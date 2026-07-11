/**
 * Regression coverage for issue #7230 at the *rendering* layer: even with
 * schema-level sanitization (`WebUrlSanitization.vitest.ts`), the formatters
 * that bind `href` from web_search/web_fetch tool payloads
 * (`webFormatters.ts`) must never emit a live anchor for a dangerous scheme,
 * and must still render legitimate links normally.
 */
// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import { LOG_LEVELS, type LogMessageData } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () =>
    import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters'),
);

function webSearchMessage(url: string): LogMessageData {
  return {
    id: 'web-search-1',
    text: '',
    level: LOG_LEVELS.INFO,
    timestamp: 1,
    messageType: 'webSearch',
    data: {
      query: 'test query',
      provider: 'anthropic',
      status: 'completed',
      results: [{ url, title: 'Click me', domain: 'example.com' }],
    },
  };
}

function webFetchMessage(url: string): LogMessageData {
  return {
    id: 'web-fetch-1',
    text: '',
    level: LOG_LEVELS.INFO,
    timestamp: 1,
    messageType: 'webFetch',
    data: {
      url,
      title: 'Fetched page',
      status: 'completed',
    },
  };
}

const DANGEROUS_URLS = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
];

describe('web-search/web-fetch formatters: URL scheme sanitization', () => {
  describe('web_search results', () => {
    it.each(DANGEROUS_URLS)(
      'never renders %s as a clickable href',
      async (url) => {
        const { formatWebSearchTemplate } =
          await import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters');
        const { render } = await import('lit');

        const container = document.createElement('div');
        render(formatWebSearchTemplate(webSearchMessage(url)), container);

        // The single result carries only a dangerous URL, so it must render
        // as inert text — no anchor at all, not merely an anchor with a
        // neutralized href.
        expect(container.querySelectorAll('a').length).toBe(0);
        // The result should still be visible (as inert text), just not linked.
        expect(container.textContent).toContain('Click me');
      },
    );

    it('renders a legitimate https URL as a real clickable href', async () => {
      const { formatWebSearchTemplate } =
        await import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters');
      const { render } = await import('lit');
      const url = 'https://example.com/article?id=42';

      const container = document.createElement('div');
      render(formatWebSearchTemplate(webSearchMessage(url)), container);

      const anchor = container.querySelector('a.web-search-link');
      expect(anchor).not.toBeNull();
      expect(anchor?.getAttribute('href')).toBe(url);
      expect(anchor?.textContent).toContain('Click me');

      // Element-name pin (#8156): web-search banners render through
      // <wa-details>, matching the wa-details convention used elsewhere on
      // this surface — never the native <details> element.
      expect(
        container.querySelector('wa-details.tool-use-details'),
      ).not.toBeNull();
      expect(container.querySelector('details')).toBeNull();
    });

    it('renders a mailto URL as a real clickable href', async () => {
      const { formatWebSearchTemplate } =
        await import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters');
      const { render } = await import('lit');
      const url = 'mailto:someone@example.com';

      const container = document.createElement('div');
      render(formatWebSearchTemplate(webSearchMessage(url)), container);

      const anchor = container.querySelector('a.web-search-link');
      expect(anchor?.getAttribute('href')).toBe(url);
    });
  });

  describe('web_fetch payloads', () => {
    it.each(DANGEROUS_URLS)(
      'never renders %s as a clickable href',
      async (url) => {
        const { formatWebFetchTemplate } =
          await import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters');
        const { render } = await import('lit');

        const container = document.createElement('div');
        render(formatWebFetchTemplate(webFetchMessage(url)), container);

        // The "URL:" section is only rendered when a safe URL survives
        // sanitization, so a dangerous URL must produce no anchor at all.
        expect(container.querySelectorAll('a').length).toBe(0);
      },
    );

    it('renders a legitimate https URL as a real clickable href', async () => {
      const { formatWebFetchTemplate } =
        await import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters');
      const { render } = await import('lit');
      const url = 'https://example.com/doc.pdf';

      const container = document.createElement('div');
      render(formatWebFetchTemplate(webFetchMessage(url)), container);

      const anchor = container.querySelector('a.web-search-link');
      expect(anchor).not.toBeNull();
      expect(anchor?.getAttribute('href')).toBe(url);
      expect(anchor?.textContent).toBe(url);
    });
  });
});
