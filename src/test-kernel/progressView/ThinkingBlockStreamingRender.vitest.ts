import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  type LogMessageData,
} from '@shared/schemas';

/**
 * Regression coverage for #7276: a thinking/scratchpad/model-response entry
 * that's still streaming in (`data.status: 'running'`) must render through
 * the same collapsible banner shell (`formatBannerContentTemplate`) as a
 * finalized entry — never fall back to the plain `log-line` template, which
 * is visually indistinguishable from an unrelated info log.
 */
describe('progress view live activity rendering', () => {
  let dom: JSDOM;

  beforeAll(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      Node: dom.window.Node,
      Element: dom.window.Element,
      DocumentFragment: dom.window.DocumentFragment,
    });
  });

  afterAll(() => {
    dom.window.close();
  });

  it('renders a banner-details shell, not a plain log line, while the stream is running', async () => {
    const { formatLogEntry } =
      await import('@progressView/frontend/formatters');
    const { render } = await import('lit');

    const message: LogMessageData = {
      id: 'think-1',
      text: '**bold** reasoning in progress',
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.THINKING,
      data: { status: 'running' },
    };

    const container = document.createElement('div');
    render(formatLogEntry(message), container);

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

  it('does not render ephemeral context-compaction activity', async () => {
    const { formatLogEntry } =
      await import('@progressView/frontend/formatters');
    const { render } = await import('lit');

    const message: LogMessageData = {
      id: 'compaction-1',
      text: 'Compacting conversation context',
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      data: {
        activity: 'context_compaction',
        state: 'started',
      },
    };

    const container = document.createElement('div');
    render(formatLogEntry(message), container);

    expect(container.textContent).toBe('');
    expect(container.childElementCount).toBe(0);
  });

  it('preserves newlines in raw text while streaming', async () => {
    const { formatLogEntry } =
      await import('@progressView/frontend/formatters');
    const { render } = await import('lit');

    const message: LogMessageData = {
      id: 'think-multiline',
      text: 'line one\nline two',
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.THINKING,
      data: { status: 'running' },
    };

    const container = document.createElement('div');
    render(formatLogEntry(message), container);

    const content = container.querySelector('.banner-content--streaming');
    expect(content?.textContent).toBe('line one\nline two');
  });

  it('upgrades to rendered markdown once the stream finalizes, inside the same banner shell', async () => {
    const { formatLogEntry } =
      await import('@progressView/frontend/formatters');
    const { render } = await import('lit');

    const message: LogMessageData = {
      id: 'think-1',
      text: '**bold** reasoning done',
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.THINKING,
      data: { status: 'completed' },
    };

    const container = document.createElement('div');
    render(formatLogEntry(message), container);

    const details = container.querySelector('wa-details.banner-details');
    expect(details).not.toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    // No caller-supplied defaultOpen/preservedOpen here, so a finalized
    // thinking block collapses back down once it's no longer streaming.
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('applies the same running/finalized behavior to model-response entries', async () => {
    const { formatLogEntry } =
      await import('@progressView/frontend/formatters');
    const { render } = await import('lit');

    const runningMessage: LogMessageData = {
      id: 'resp-1',
      text: '**bold** answer in progress',
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      data: { status: 'running' },
    };

    const runningContainer = document.createElement('div');
    render(formatLogEntry(runningMessage), runningContainer);

    const runningDetails = runningContainer.querySelector(
      'wa-details.banner-details',
    );
    expect(runningDetails).not.toBeNull();
    expect(runningContainer.querySelector('.log-line')).toBeNull();
    expect(runningContainer.querySelector('strong')).toBeNull();
    expect(runningDetails?.hasAttribute('open')).toBe(true);
  });

  it('resolves the scratchpad banner config (pencil icon, "Scratchpad" label), not the thinking default', async () => {
    const { formatLogEntry } =
      await import('@progressView/frontend/formatters');
    const { render } = await import('lit');

    const message: LogMessageData = {
      id: 'scratch-1',
      text: 'jotting down a formula',
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.SCRATCHPAD,
      data: { status: 'running' },
    };

    const container = document.createElement('div');
    render(formatLogEntry(message), container);

    const details = container.querySelector('wa-details.banner-details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(true);
    expect(container.textContent).toContain('Scratchpad');
    expect(container.querySelector('wa-icon[name="pencil"]')).not.toBeNull();
  });
});
