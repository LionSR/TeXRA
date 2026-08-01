// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function makeStream(name: string): StreamTabInfo {
  return {
    kind: 'agent',
    name,
    label: name,
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
  };
}

/** Let the nested <stream-tab> finish its own first render. */
function settleChildRender(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountTabs(props: Partial<StreamTabs>): Promise<StreamTabs> {
  const element = await mountComponent<StreamTabs>('stream-tabs', props);
  await settleChildRender();
  return element;
}

/**
 * Regression coverage: the child-stream expand/collapse chevron renders as
 * the shared `wa-button` action-icon pattern (matching the sibling delete
 * button two elements over), not a hand-rolled native `<button>` reset. The
 * delegated click handler in StreamTabs.handleTabClick keys off
 * `[data-stream][data-action]`, so the element must keep carrying both
 * attributes regardless of tag name.
 */
describe('stream-tab expand chevron', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamTabs'),
  );

  it('renders the expand toggle as a wa-button carrying the delegated-click contract', async () => {
    const tabs = await mountTabs({
      streams: [makeStream('parent')],
      childStreamsByParent: new Map([['parent', [makeStream('child')]]]),
    });
    const parentTab = tabs.shadowRoot?.querySelector('stream-tab');
    expect(parentTab).toBeTruthy();

    const expandButton = parentTab?.shadowRoot?.querySelector('.tab-expand');
    expect(expandButton).toBeTruthy();
    expect(expandButton?.tagName).toBe('WA-BUTTON');
    expect(expandButton?.getAttribute('data-stream')).toBe('parent');
    expect(expandButton?.getAttribute('data-action')).toBe('toggle-children');
    expect(expandButton?.hasAttribute('aria-expanded')).toBe(true);
    const expectedLabel =
      expandButton?.getAttribute('aria-expanded') === 'true'
        ? 'Collapse child streams'
        : '1 child stream';
    expect(expandButton?.getAttribute('aria-label')).toBe(expectedLabel);
    expect(
      parentTab?.shadowRoot
        ?.querySelector('wa-tooltip[for="stream-tab-expand-button"]')
        ?.textContent?.trim(),
    ).toBe(expectedLabel);
  });

  it('identifies an unlabeled stream by name in the select aria-label', async () => {
    const tabs = await mountTabs({
      streams: [{ ...makeStream('unlabeled-stream'), label: '' }],
    });

    const ariaLabel = tabs.shadowRoot
      ?.querySelector('stream-tab')
      ?.shadowRoot?.querySelector('#stream-tab-select-button')
      ?.getAttribute('aria-label');
    expect(ariaLabel).toContain('unlabeled-stream');
  });

  it('renders no session footer', async () => {
    const tabs = await mountTabs({ streams: [makeStream('session')] });

    expect(tabs.shadowRoot?.querySelector('.stream-list-footer')).toBeNull();
    expect(tabs.shadowRoot?.querySelector('stream-tab')).toBeTruthy();
  });

  it('anchors the general hint to the title, not an ancestor of specific hints', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          ...makeStream('remote'),
          isRemote: true,
          worktree: {
            workingDirectory: '/tmp/texra/remote',
            branch: 'remote',
          },
        },
      ],
    });

    const tab = tabs.shadowRoot?.querySelector('stream-tab');
    const shadow = tab?.shadowRoot;
    const title = shadow?.querySelector('#stream-tab-title');
    const select = shadow?.querySelector('#stream-tab-select-button');

    expect(
      shadow?.querySelector('wa-tooltip[for="stream-tab-select-button"]'),
    ).toBeNull();
    expect(
      shadow?.querySelector('wa-tooltip[for="stream-tab-title"]'),
    ).toBeNull();
    expect(select?.getAttribute('aria-label')).toContain('Status:');
    expect(
      title?.contains(shadow?.querySelector('#stream-tab-kind') ?? null),
    ).toBe(false);
    expect(
      title?.contains(shadow?.querySelector('#stream-tab-remote') ?? null),
    ).toBe(false);
    expect(
      title?.contains(shadow?.querySelector('worktree-chip') ?? null),
    ).toBe(false);

    tabs.compact = true;
    tabs.childStreamsByParent = new Map([
      ['remote', [makeStream('remote-child')]],
    ]);
    await tabs.updateComplete;
    await settleChildRender();

    const compactShadow =
      tabs.shadowRoot?.querySelector('stream-tab')?.shadowRoot;
    expect(
      compactShadow
        ?.querySelector('#stream-tab-title')
        ?.contains(compactShadow.querySelector('#stream-tab-compact-children')),
    ).toBe(false);
  });

  it('renders workflow scripts as orchestration streams without a model', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          kind: 'workflowScript',
          name: 'workflow-script#abc123',
          label: 'repo-cleanup-readonly-pilot-2026-07-24',
          workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
          agentCategory: AgentCategory.Workflow,
          creationTimestamp: 1,
        },
      ],
    });

    const tab = tabs.shadowRoot?.querySelector('stream-tab');
    const model = tab?.shadowRoot?.querySelector('.model');
    const kindIcon = tab?.shadowRoot?.querySelector('.stream-kind') as
      (Element & { name?: string }) | null;

    expect(model?.textContent?.trim()).toBe('');
    expect(kindIcon?.name).toBe('list-ul');
    expect(kindIcon?.hasAttribute('title')).toBe(false);
    expect(
      tab?.shadowRoot
        ?.querySelector('wa-tooltip[for="stream-tab-kind"]')
        ?.textContent?.trim(),
    ).toBe('Workflow Script');
  });
});
