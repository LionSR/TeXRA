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
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas/agentSkills';
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

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

function mount(
  items: ToolDashboardItem[],
  props: Partial<ToolsTab> = {},
): Promise<ToolsTab> {
  return mountComponent<ToolsTab>('tools-tab', {
    loaded: true,
    items,
    ...props,
  });
}

describe('tools-tab availability summary', () => {
  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('shows the available count without a decorative progress ring', async () => {
    const element = await mount([
      tool('ready', 'available'),
      tool('missing', 'not-found'),
    ]);
    expect(element.shadowRoot?.querySelector('wa-progress-ring')).toBeNull();
    expect(element.shadowRoot?.textContent).toContain('1/2 available');
  });

  it('renders and updates the shared agent-skills switch', async () => {
    const element = await mount([]);
    const skillSwitch = element.shadowRoot?.querySelector<
      HTMLElement & { checked?: boolean }
    >('wa-switch[aria-label="Make skills available to tool-use agents"]');

    expect(skillSwitch).not.toBeNull();
    expect(skillSwitch?.checked).toBe(true);

    if (!skillSwitch) return;
    skillSwitch.checked = false;
    skillSwitch.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      { key: AGENT_SKILLS_CONFIG_KEY, value: false },
    );
  });

  it('renders and updates working-directory path protection', async () => {
    const element = await mount([tool('file-ops', 'available')], {
      toolPathProtectionEnabled: false,
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
