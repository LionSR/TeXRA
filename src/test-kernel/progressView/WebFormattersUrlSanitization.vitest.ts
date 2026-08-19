// Regression coverage for issue #7230 at the rendering layer: the web
// formatters must never emit a live anchor for a dangerous scheme even when
// the schema layer has already been sanitized.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  LOG_LEVELS,
  STREAM_LOG_ENTRY_TYPES,
  StreamLogEntrySchema,
} from '@shared/schemas';
import {
  projectTranscriptRow,
  type WebFetchRow,
  type WebSearchRow,
} from '@shared/transcript';
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

type WebFormatters =
  typeof import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters');

useLitComponentTestDom(
  () =>
    import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters'),
);

let formatWebSearchTemplate: WebFormatters['formatWebSearchTemplate'];
let formatWebFetchTemplate: WebFormatters['formatWebFetchTemplate'];
let render: typeof import('lit').render;

beforeAll(async () => {
  ({ formatWebSearchTemplate, formatWebFetchTemplate } =
    await import('@progressView/frontend/formatters/logFormatters/toolFormatters/webFormatters'));
  ({ render } = await import('lit'));
});

function webSearchRow(url: string): WebSearchRow {
  const entry = StreamLogEntrySchema.parse({
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    seqNo: 1,
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
  });
  return projectTranscriptRow(entry) as WebSearchRow;
}

function webFetchRow(url: string): WebFetchRow {
  const entry = StreamLogEntrySchema.parse({
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    seqNo: 1,
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
  });
  return projectTranscriptRow(entry) as WebFetchRow;
}

function renderTemplate(template: Parameters<typeof render>[0]): HTMLElement {
  const container = document.createElement('div');
  render(template, container);
  return container;
}

const DANGEROUS_URLS = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
];

describe('web-search/web-fetch formatters: URL scheme sanitization', () => {
  describe('web_search results', () => {
    it.each(DANGEROUS_URLS)('never renders %s as a clickable href', (url) => {
      const container = renderTemplate(
        formatWebSearchTemplate(webSearchRow(url)),
      );

      // The single result carries only a dangerous URL, so it must render
      // as inert text — no anchor at all, not merely an anchor with a
      // neutralized href.
      expect(container.querySelectorAll('a').length).toBe(0);
      // The result should still be visible (as inert text), just not linked.
      expect(container.textContent).toContain('Click me');
    });

    it('renders a legitimate https URL as a real clickable href', () => {
      const url = 'https://example.com/article?id=42';

      const container = renderTemplate(
        formatWebSearchTemplate(webSearchRow(url)),
      );

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

    it('renders a mailto URL as a real clickable href', () => {
      const url = 'mailto:someone@example.com';

      const container = renderTemplate(
        formatWebSearchTemplate(webSearchRow(url)),
      );

      const anchor = container.querySelector('a.web-search-link');
      expect(anchor?.getAttribute('href')).toBe(url);
    });
  });

  describe('web_fetch payloads', () => {
    it.each(DANGEROUS_URLS)('never renders %s as a clickable href', (url) => {
      const container = renderTemplate(
        formatWebFetchTemplate(webFetchRow(url)),
      );

      // The "URL:" section is only rendered when a safe URL survives
      // sanitization, so a dangerous URL must produce no anchor at all.
      expect(container.querySelectorAll('a').length).toBe(0);
    });

    it('renders a legitimate https URL as a real clickable href', () => {
      const url = 'https://example.com/doc.pdf';

      const container = renderTemplate(
        formatWebFetchTemplate(webFetchRow(url)),
      );

      const anchor = container.querySelector('a.web-search-link');
      expect(anchor).not.toBeNull();
      expect(anchor?.getAttribute('href')).toBe(url);
      expect(anchor?.textContent).toBe(url);
    });
  });
});
