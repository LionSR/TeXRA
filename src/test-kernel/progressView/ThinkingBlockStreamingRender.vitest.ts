import { describe, expect, it } from 'vitest';

import { LOG_LEVELS, MESSAGE_TYPES } from '@shared/schemas';
import { streamingTextRow, type TranscriptRow } from '@ui/transcript';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

// Loaded after the jsdom globals are installed: lit and the formatters both
// capture `document` at import time.
let formatLogEntry: typeof import('@progressView/frontend/formatters').formatLogEntry;
let render: typeof import('lit').render;

function renderRow(row: TranscriptRow | undefined): Element {
  const container = document.createElement('div');
  render(formatLogEntry(row!), container);
  return container;
}

/** A thinking row, streaming unless the test says otherwise. */
function thinkingRow(
  id: string,
  text: string,
  streaming = true,
): TranscriptRow {
  return streamingTextRow(
    {
      id,
      seqNo: 1,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.THINKING,
    },
    'thinking',
    text,
    streaming,
  )!;
}

/**
 * Regression coverage for #7276: a thinking/scratchpad/model-response entry
 * that's still streaming in (`data.status: 'running'`) must render through
 * the same collapsible banner shell (`formatBannerContentTemplate`) as a
 * finalized entry — never fall back to the plain `log-line` template, which
 * is visually indistinguishable from an unrelated info log.
 */
describe('progress view live activity rendering', () => {
  useLitComponentTestDom(async () => {
    ({ formatLogEntry } = await import('@progressView/frontend/formatters'));
    ({ render } = await import('lit'));
  });

  it('renders a banner-details shell, not a plain log line, while the stream is running', () => {
    const container = renderRow(
      thinkingRow('think-1', '**bold** reasoning in progress'),
    );

    const details = container.querySelector('wa-details.banner-details');
    expect(details).not.toBeNull();
    expect(details?.getAttribute('icon-placement')).toBe('start');
    expect(container.querySelector('.log-line')).toBeNull();
    // Auto-expanded while streaming, so the growing text is actually visible.
    expect(details?.hasAttribute('open')).toBe(true);
    // Markdown parsing is skipped while running — raw text, not rendered HTML.
    expect(container.textContent).toContain('**bold** reasoning in progress');
    expect(container.querySelector('strong')).toBeNull();
    // Raw text needs its own whitespace rule (no <p>/<br> from markdown).
    expect(
      container.querySelector('.banner-content--streaming'),
    ).not.toBeNull();
  });

  it('upgrades to rendered markdown once the stream finalizes, inside the same banner shell', () => {
    const container = renderRow(
      thinkingRow('think-1', '**bold** reasoning done', false),
    );

    const details = container.querySelector('wa-details.banner-details');
    expect(details).not.toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    // No caller-supplied defaultOpen/preservedOpen here, so a finalized
    // thinking block collapses back down once it's no longer streaming.
    expect(details?.hasAttribute('open')).toBe(false);
  });
});
