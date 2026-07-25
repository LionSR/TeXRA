// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ContextManagement } from '@progressView/frontend/components/ContextManagement';
import type { LatexdiffResults } from '@progressView/frontend/components/LatexdiffResults';
import type { QueuedFollowUps } from '@progressView/frontend/components/QueuedFollowUps';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function expectUniqueIds(root: ShadowRoot): void {
  const ids = [...root.querySelectorAll<HTMLElement>('[id]')].map(
    (element) => element.id,
  );
  expect(new Set(ids).size).toBe(ids.length);
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
    const element = document.createElement(
      'context-management',
    ) as ContextManagement;
    element.items = [
      { icon: 'history', label: 'Before', value: '10k' },
      { icon: 'history', label: 'After', value: '5k' },
    ];
    document.body.append(element);
    await element.updateComplete;

    const shadow = element.shadowRoot!;
    expect(shadow.querySelector('[title]')).toBeNull();
    expectUniqueIds(shadow);
    expect(
      shadow.querySelector('wa-tooltip[for="context-stat-1"]')?.textContent,
    ).toBe('After');
  });

  it('only adds the queued-message tooltip when text is truncated', async () => {
    const full = 'x'.repeat(201);
    const element = document.createElement(
      'queued-follow-ups',
    ) as QueuedFollowUps;
    element.messages = ['short', full];
    document.body.append(element);
    await element.updateComplete;

    const shadow = element.shadowRoot!;
    expect(shadow.querySelector('[title]')).toBeNull();
    expectUniqueIds(shadow);
    expect(
      shadow.querySelector('wa-tooltip[for="queued-follow-up-0"]'),
    ).toBeNull();
    expect(
      shadow.querySelector('wa-tooltip[for="queued-follow-up-1"]')?.textContent,
    ).toBe(full);
  });

  it('anchors latexdiff messages to their indexed rows', async () => {
    const element = document.createElement(
      'latexdiff-results',
    ) as LatexdiffResults;
    element.entries = [
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
    ];
    document.body.append(element);
    await element.updateComplete;

    const shadow = element.shadowRoot!;
    expect(shadow.querySelector('[title]')).toBeNull();
    expectUniqueIds(shadow);
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
