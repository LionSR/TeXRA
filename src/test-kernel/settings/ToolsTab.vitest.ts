import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type { ToolsTab } from '@settingsView/frontend/tabs/ToolsTab';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas/agentSkills';
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

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

/**
 * Mounts the tab, pins the switch's label and initial state, flips it, and
 * asserts the resulting UPDATE_STATE_SETTING message.
 */
async function expectTogglableSwitch(options: {
  items?: ToolDashboardItem[];
  props?: Partial<ToolsTab>;
  id: string;
  label: string;
  initialChecked: boolean;
  stateKey: string;
}): Promise<void> {
  const element = await mount(options.items ?? [], options.props);
  const toggle = element.shadowRoot?.querySelector<
    HTMLElement & { checked?: boolean }
  >(`wa-switch#${options.id}`);

  expect(toggle).not.toBeNull();
  // The <label for> is what names the control; a host aria-label never
  // reached the role-bearing input inside wa-switch's shadow root.
  expect(
    element.shadowRoot?.querySelector(`label[for="${options.id}"]`)
      ?.textContent,
  ).toBe(options.label);
  expect(toggle?.checked).toBe(options.initialChecked);

  toggle!.checked = !options.initialChecked;
  toggle!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  expect(mocks.postMessage).toHaveBeenCalledWith(
    SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
    { key: options.stateKey, value: !options.initialChecked },
  );
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

  it('reports complete availability without a missing-state label', async () => {
    const element = await mount([
      tool('first', 'available'),
      tool('second', 'available'),
    ]);
    expect(element.shadowRoot?.textContent).toContain('2/2 available');
  });

  it('renders and updates the shared agent-skills switch', async () => {
    await expectTogglableSwitch({
      id: 'settings-toggle-make-skills-available-to-tool-use-agents',
      label: 'Make skills available to tool-use agents',
      initialChecked: true,
      stateKey: AGENT_SKILLS_CONFIG_KEY,
    });
  });

  it('renders and updates working-directory path protection', async () => {
    await expectTogglableSwitch({
      items: [tool('file-ops', 'available')],
      props: { toolPathProtectionEnabled: false },
      id: 'settings-toggle-restrict-tool-paths-to-the-working-directory',
      label: 'Restrict tool paths to the working directory',
      initialChecked: false,
      stateKey: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
    });
  });
});
