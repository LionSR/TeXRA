import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  type LogMessageData,
} from '@shared/schemas';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

// Loaded after the jsdom globals are installed: lit and the formatters both
// capture `document` at import time.
let formatLogEntry: typeof import('@progressView/frontend/formatters').formatLogEntry;
let render: typeof import('lit').render;

function renderEntry(message: LogMessageData): Element {
  const container = document.createElement('div');
  render(formatLogEntry(message), container);
  return container;
}

/** A streaming thinking entry, overridable per test. */
function logMessage(overrides: Partial<LogMessageData>): LogMessageData {
  return {
    id: 'msg-1',
    text: 'text',
    level: LOG_LEVELS.INFO,
    timestamp: 100,
    messageType: MESSAGE_TYPES.THINKING,
    data: { status: 'running' },
    ...overrides,
  };
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
    const container = renderEntry(
      logMessage({ id: 'think-1', text: '**bold** reasoning in progress' }),
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

  it('renders projected context compaction as a non-collapsible activity', async () => {
    const container = renderEntry(
      logMessage({
        id: 'compaction:operation-1',
        text: '',
        messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
        data: {
          operationId: 'operation-1',
          status: 'running',
          startPosition: 4,
          startedAt: 10,
        },
      }),
    );
    const activity = container.querySelector('compaction-activity');
    expect(activity).not.toBeNull();
    document.body.append(container);
    await (activity as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;

    expect(activity?.shadowRoot?.textContent).toContain('Compacting context…');
    expect(activity?.shadowRoot?.querySelector('wa-details')).toBeNull();
    expect(
      activity?.shadowRoot?.querySelector('[role="status"]'),
    ).not.toBeNull();
  });

  it('preserves newlines in raw text while streaming', () => {
    const container = renderEntry(
      logMessage({ id: 'think-multiline', text: 'line one\nline two' }),
    );

    const content = container.querySelector('.banner-content--streaming');
    expect(content?.textContent).toBe('line one\nline two');
  });

  it('upgrades to rendered markdown once the stream finalizes, inside the same banner shell', () => {
    const container = renderEntry(
      logMessage({
        id: 'think-1',
        text: '**bold** reasoning done',
        data: { status: 'completed' },
      }),
    );

    const details = container.querySelector('wa-details.banner-details');
    expect(details).not.toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    // No caller-supplied defaultOpen/preservedOpen here, so a finalized
    // thinking block collapses back down once it's no longer streaming.
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('applies the same running/finalized behavior to model-response entries', () => {
    const runningContainer = renderEntry(
      logMessage({
        id: 'resp-1',
        text: '**bold** answer in progress',
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      }),
    );

    const runningDetails = runningContainer.querySelector(
      'wa-details.banner-details',
    );
    expect(runningDetails).not.toBeNull();
    expect(runningContainer.querySelector('.log-line')).toBeNull();
    expect(runningContainer.querySelector('strong')).toBeNull();
    expect(runningDetails?.hasAttribute('open')).toBe(true);
  });

  it('resolves the scratchpad banner config (pencil icon, "Scratchpad" label), not the thinking default', () => {
    const container = renderEntry(
      logMessage({
        id: 'scratch-1',
        text: 'jotting down a formula',
        messageType: MESSAGE_TYPES.SCRATCHPAD,
      }),
    );

    const details = container.querySelector('wa-details.banner-details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(true);
    expect(container.textContent).toContain('Scratchpad');
    expect(container.querySelector('wa-icon[name="pencil"]')).not.toBeNull();
  });
});
