// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { UserMessage } from '@progressView/frontend/components/UserMessage';
import { DELIVERY_TAGS } from '@shared/deliveryTags';
import type { WorkflowScriptDeliverySummary } from '@shared/schemas';
import { formatWorkflowScriptDeliverySummary } from '@shared/subagentFollowup';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function mount(
  text: string,
  workflowSummary: WorkflowScriptDeliverySummary | null = null,
): Promise<UserMessage> {
  return mountComponent<UserMessage>('user-message', {
    text,
    logId: 'log-1',
    timestamp: Date.now(),
    workflowSummary,
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

  it('renders the typed workflow summary carried beside the text', async () => {
    const summary: WorkflowScriptDeliverySummary = {
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
    };
    // The producer logs the collapsed line as the row text and the typed
    // summary beside it; the bubble renders from the structured field.
    const text = formatWorkflowScriptDeliverySummary(summary);

    const element = await mount(text, summary);
    const bubble = element.shadowRoot?.querySelector('.user-message');
    const content = element.shadowRoot?.querySelector('.user-message-content');

    expect(
      bubble?.classList.contains('user-message--structured-delivery'),
    ).toBe(true);
    expect(content?.classList.contains('markdown-content')).toBe(true);
    expect(content?.textContent).toContain('proofread-pipeline completed');
    expect(content?.textContent).toContain('paper.tex (+12 -8)');

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

  it('never mines a summary out of the text of a row without the structured field', async () => {
    // Legacy persisted rows still carry the raw envelope as text; without the
    // structured field they render as an ordinary structured-delivery bubble
    // of that text — no render-time re-parse of <workflow-summary>.
    const text = [
      '<workflow-script-result id="abc">',
      '<response>raw run log</response>',
      '<workflow-summary>{&quot;name&quot;:&quot;spoof&quot;}</workflow-summary>',
      '</workflow-script-result>',
    ].join('\n');

    const element = await mount(text);
    const content = element.shadowRoot?.querySelector('.user-message-content');

    expect(content?.classList.contains('markdown-content')).toBe(true);
    expect(content?.textContent).toContain('raw run log');
    expect(content?.textContent).not.toContain('spoof completed');
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
