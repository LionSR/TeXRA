// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ContextManagement } from '@progressView/frontend/components/ContextManagement';
import type { LatexdiffResults } from '@progressView/frontend/components/LatexdiffResults';
import type { QueuedFollowUps } from '@progressView/frontend/components/QueuedFollowUps';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

/**
 * Mount a component and return its shadow root after asserting the shared
 * tooltip contract: no native [title] attributes and no duplicate ids.
 */
async function mountCheckedShadow<
  T extends HTMLElement & { updateComplete: Promise<unknown> },
>(tag: string, props: Partial<T>): Promise<ShadowRoot> {
  const element = await mountComponent<T>(tag, props);
  const shadow = element.shadowRoot!;
  expect(shadow.querySelector('[title]')).toBeNull();
  const ids = [...shadow.querySelectorAll<HTMLElement>('[id]')].map(
    (element) => element.id,
  );
  expect(new Set(ids).size).toBe(ids.length);
  return shadow;
}

describe('remaining progress-view tooltip contracts', () => {
  useLitComponentTestDom(() =>
    Promise.all([
      import('@progressView/frontend/components/ContextManagement'),
      import('@progressView/frontend/components/LatexdiffResults'),
      import('@progressView/frontend/components/QueuedFollowUps'),
    ]),
  );

  it('anchors repeated context-stat hints with indexed ids', async () => {
    const shadow = await mountCheckedShadow<ContextManagement>(
      'context-management',
      {
        config: {
          icon: 'clock-rotate-left',
          label: 'Context Management',
          color: 'var(--wa-color-text-normal)',
        },
        items: [
          { icon: 'clock-rotate-left', label: 'Before', value: '10k' },
          { icon: 'clock-rotate-left', label: 'After', value: '5k' },
        ],
      },
    );

    expect(
      shadow.querySelector('wa-tooltip[for="context-stat-1"]')?.textContent,
    ).toBe('After');
  });

  it('only adds the queued-message tooltip when text is truncated', async () => {
    const full = 'x'.repeat(201);
    const shadow = await mountCheckedShadow<QueuedFollowUps>(
      'queued-follow-ups',
      {
        messages: ['short', full],
      },
    );

    expect(
      shadow.querySelector('wa-tooltip[for="queued-follow-up-0"]'),
    ).toBeNull();
    expect(
      shadow.querySelector('wa-tooltip[for="queued-follow-up-1"]')?.textContent,
    ).toBe(full);
  });

  it('anchors latexdiff messages to their indexed rows', async () => {
    const shadow = await mountCheckedShadow<LatexdiffResults>(
      'latexdiff-results',
      {
        entries: [
          {
            baseFile: '/workspace/paper.tex',
            revisedFile: '/workspace/paper-revised.tex',
            diffFile: '/workspace/paper-diff.pdf',
            displayName: 'paper.tex',
            baseRound: null,
            revisedRound: 1,
            status: 'error',
            message: 'LaTeXdiff failed',
          },
        ],
      },
    );

    const row = shadow.querySelector('#latexdiff-entry-0');
    const tooltip = shadow.querySelector('wa-tooltip[for="latexdiff-entry-0"]');
    expect(tooltip?.textContent).toBe('LaTeXdiff failed');
    expect(tooltip?.parentElement).toBe(row);
    expect(
      [...(shadow.querySelector('.latexdiff-content')?.children ?? [])].every(
        (child) => child.tagName === 'LI',
      ),
    ).toBe(true);
  });
});
