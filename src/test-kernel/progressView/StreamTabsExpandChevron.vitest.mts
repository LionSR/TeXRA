// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progressView frontend
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';

// Local imports - shared schemas
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

// Local imports - test utilities
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
});
