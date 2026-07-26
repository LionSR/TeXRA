// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

// Local imports - component and schema types
import type { ToolsTab } from '@settingsView/frontend/tabs/ToolsTab';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

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

async function mount(
  items: ToolDashboardItem[],
  configure: (element: ToolsTab) => void = () => undefined,
): Promise<ToolsTab> {
  const element = document.createElement('tools-tab') as ToolsTab;
  element.loaded = true;
  element.items = items;
  configure(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe('tools-tab availability summary', () => {
  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

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

  it('leaves the VS Code setting as the extension editable surface', async () => {
    const element = await mount([]);

    expect(element.shadowRoot?.textContent).not.toContain('Agent Skills');
  });

  it('renders and updates the shared agent-skills switch', async () => {
    const element = await mount([], (toolsTab) => {
      toolsTab.showAgentSkillsSettings = true;
    });
    const skillSwitch = [
      ...(element.shadowRoot?.querySelectorAll('wa-switch') ?? []),
    ].find((candidate) =>
      candidate.textContent?.includes(
        'TeXRA and imported skills are available to tool-use agents',
      ),
    ) as (HTMLElement & { checked?: boolean }) | undefined;

    expect(skillSwitch).toBeDefined();
    expect(skillSwitch?.checked).toBe(true);

    if (!skillSwitch) return;
    skillSwitch.checked = false;
    skillSwitch.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.SET_AGENT_SKILLS_ENABLED,
      { enabled: false },
    );
  });

  it('renders and updates working-directory path protection', async () => {
    const element = await mount([tool('file-ops', 'available')], (toolsTab) => {
      toolsTab.toolPathProtectionEnabled = false;
    });
    const protectionSwitch = [
      ...(element.shadowRoot?.querySelectorAll('wa-switch') ?? []),
    ].find((candidate) =>
      candidate.textContent?.includes(
        'Restrict tool paths to the working directory',
      ),
    ) as (HTMLElement & { checked?: boolean }) | undefined;

    expect(protectionSwitch).toBeDefined();
    expect(protectionSwitch?.checked).toBe(false);

    if (!protectionSwitch) return;
    protectionSwitch.checked = true;
    protectionSwitch.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      {
        key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
        value: true,
      },
    );
  });
});
