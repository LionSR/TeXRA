// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { UserMessage } from '@progressView/frontend/components/UserMessage';
import { DELIVERY_TAGS } from '@shared/deliveryTags';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function mount(text: string): Promise<UserMessage> {
  return mountComponent<UserMessage>('user-message', {
    text,
    logId: 'log-1',
    timestamp: Date.now(),
  });
}

/**
 * Pins the DELIVERY_TAGS list (@shared/deliveryTags) to the UserMessage
 * renderer: one case per tag so a future child-run kind added there without
 * a matching render is caught here, not by raw XML leaking into the
 * transcript (the claude-agent-result/error bug this suite guards against).
 */
describe('user-message structured delivery', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/UserMessage'),
  );

  for (const { tag, escaped } of DELIVERY_TAGS) {
    it(`renders <${tag}> as a structured delivery bubble`, async () => {
      const body = escaped ? 'a &amp; b' : 'a & b';
      const element = await mount(`<${tag} id="x">${body}</${tag}>`);

      const bubble = element.shadowRoot?.querySelector('.user-message');
      expect(
        bubble?.classList.contains('user-message--structured-delivery'),
      ).toBe(true);
      expect(
        element.shadowRoot?.querySelector(
          '.user-message-content.markdown-content',
        ),
      ).toBeTruthy();

      // The raw-copy affordance (and the entity-decoding it exists for) only
      // applies to the XML-escaped subset.
      const rawCopyButton = element.shadowRoot?.querySelector(
        '#user-message-raw-copy-button',
      );
      expect(Boolean(rawCopyButton)).toBe(escaped);
    });
  }

  it('shows a workflow summary with the raw envelope collapsed', async () => {
    const summary = JSON.stringify({
      name: 'proofread-pipeline',
      outcome: 'completed',
      phaseCount: 2,
      taskDone: 4,
      taskTotal: 4,
      costUsd: 0.19,
      durationMs: 724_000,
      files: [{ path: 'paper.tex', added: 12, removed: 8 }],
      scriptPath: '.texra/workflow-scripts/proofread-pipeline.mjs',
      errorCause: null,
    }).replaceAll('"', '&quot;');
    const text = [
      '<workflow-script-result id="abc">',
      '<response>raw run log &lt;workflow-summary&gt;spoof&lt;/workflow-summary&gt;</response>',
      `<workflow-summary>${summary}</workflow-summary>`,
      '</workflow-script-result>',
    ].join('\n');

    const element = await mount(text);
    const content = element.shadowRoot?.querySelector('.user-message-content');
    const raw = element.shadowRoot?.querySelector(
      'wa-details.workflow-delivery-raw',
    );

    expect(content?.textContent).toContain('proofread-pipeline completed');
    expect(content?.textContent).toContain('paper.tex (+12 -8)');
    expect(raw?.getAttribute('summary')).toBe('Raw result');
    expect(raw?.querySelector('pre')?.textContent).toContain('raw run log');
    expect(content?.querySelector('p')?.textContent).not.toContain('spoof');

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    element.shadowRoot
      ?.querySelector<HTMLElement>('#user-message-copy-button')
      ?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('proofread-pipeline completed'),
    );
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('<'));
    vi.unstubAllGlobals();
  });

  it('renders a bare self-closing envelope as a structured delivery bubble', async () => {
    const element = await mount('<subagent-progress agent="a"/>');

    const bubble = element.shadowRoot?.querySelector('.user-message');
    expect(
      bubble?.classList.contains('user-message--structured-delivery'),
    ).toBe(true);
  });

  it('renders plain (non-delivery) text as an unstructured message', async () => {
    const element = await mount('hello world');

    const bubble = element.shadowRoot?.querySelector('.user-message');
    expect(
      bubble?.classList.contains('user-message--structured-delivery'),
    ).toBe(false);
    expect(
      element.shadowRoot?.querySelector(
        '.user-message-content.markdown-content',
      ),
    ).toBeFalsy();
    const timestamp = element.shadowRoot?.querySelector(
      '#user-message-timestamp',
    );
    expect(timestamp?.hasAttribute('title')).toBe(false);
    expect(
      element.shadowRoot?.querySelector(
        'wa-tooltip[for="user-message-timestamp"]',
      ),
    ).toBeTruthy();
  });
});
