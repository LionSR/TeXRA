// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component and schema types
import type { ToolsTab } from '@settingsView/frontend/tabs/ToolsTab';
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';

// Local imports - test utilities
import { useLitComponentTestDom } from './litComponentTestUtils';

useLitComponentTestDom(() => import('@settingsView/frontend/tabs/ToolsTab'));

function tool(
  id: string,
  status: ToolDashboardItem['status'],
): ToolDashboardItem {
  return {
    id,
    name: id,
    category: 'file',
    description: `${id} description`,
    tools: [],
    status,
    requiresSetup: status !== 'available',
  };
}

async function mount(items: ToolDashboardItem[]): Promise<ToolsTab> {
  const element = document.createElement('tools-tab') as ToolsTab;
  element.loaded = true;
  element.items = items;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe('tools-tab availability summary', () => {
  it('uses an accessible Web Awesome progress ring', async () => {
    const element = await mount([
      tool('ready', 'available'),
      tool('missing', 'not-found'),
    ]);
    const ring = element.shadowRoot?.querySelector('wa-progress-ring');

    expect(ring).not.toBeNull();
    expect((ring as { value?: number }).value).toBe(50);
    expect((ring as { label?: string }).label).toBe('1 of 2 tools available');
    expect(
      element.shadowRoot?.querySelector('.tools-health-ring svg'),
    ).toBeNull();
    expect(element.shadowRoot?.textContent).toContain('1 available');
    expect(element.shadowRoot?.textContent).toContain('1 need setup');
  });

  it('reports complete availability without a missing-state label', async () => {
    const element = await mount([
      tool('first', 'available'),
      tool('second', 'available'),
    ]);
    const ring = element.shadowRoot?.querySelector('wa-progress-ring');

    expect((ring as { value?: number }).value).toBe(100);
    expect((ring as { label?: string }).label).toBe('2 of 2 tools available');
    expect(element.shadowRoot?.textContent).not.toContain('need setup');
  });
});
