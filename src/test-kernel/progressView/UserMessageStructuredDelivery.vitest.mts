// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { UserMessage } from '@progressView/frontend/components/UserMessage';
import { DELIVERY_TAGS } from '@shared/deliveryTags';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

async function mount(text: string): Promise<UserMessage> {
  const element = document.createElement('user-message') as UserMessage;
  element.text = text;
  element.logId = 'log-1';
  element.timestamp = Date.now();
  document.body.append(element);
  await element.updateComplete;
  return element;
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
