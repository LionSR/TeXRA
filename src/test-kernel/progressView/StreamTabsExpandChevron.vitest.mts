// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function makeStream(name: string): StreamTabInfo {
  return {
    kind: 'agent',
    name,
    label: name,
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
  };
}

async function mountTabs(): Promise<StreamTabs> {
  const element = document.createElement('stream-tabs') as StreamTabs;
  element.streams = [makeStream('parent')];
  element.childStreamsByParent = new Map([['parent', [makeStream('child')]]]);
  document.body.append(element);
  await element.updateComplete;
  // Let the nested <stream-tab> finish its own first render.
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    const tabs = await mountTabs();
    const parentTab = tabs.shadowRoot?.querySelector('stream-tab');
    expect(parentTab).toBeTruthy();

    const expandButton = parentTab?.shadowRoot?.querySelector('.tab-expand');
    expect(expandButton).toBeTruthy();
    expect(expandButton?.tagName).toBe('WA-BUTTON');
    expect(expandButton?.getAttribute('data-stream')).toBe('parent');
    expect(expandButton?.getAttribute('data-action')).toBe('toggle-children');
    expect(expandButton?.hasAttribute('aria-expanded')).toBe(true);
  });

  it('renders workflow scripts as orchestration streams without a model', async () => {
    const tabs = document.createElement('stream-tabs') as StreamTabs;
    tabs.streams = [
      {
        kind: 'workflowScript',
        name: 'workflow-script#abc123',
        label: 'repo-cleanup-readonly-pilot-2026-07-24',
        workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
        agentCategory: AgentCategory.Workflow,
        creationTimestamp: 1,
      },
    ];
    document.body.append(tabs);
    await tabs.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tab = tabs.shadowRoot?.querySelector('stream-tab');
    const model = tab?.shadowRoot?.querySelector('.model');
    const kindIcon = tab?.shadowRoot?.querySelector('.stream-kind') as
      (Element & { name?: string }) | null;

    expect(model?.textContent?.trim()).toBe('');
    expect(kindIcon?.name).toBe('list-tree');
    expect(kindIcon?.getAttribute('title')).toBe('Workflow Script');
  });
});
