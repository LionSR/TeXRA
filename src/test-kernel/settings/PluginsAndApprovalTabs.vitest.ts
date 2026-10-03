import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type { ApprovalTab } from '@settingsView/frontend/tabs/ApprovalTab';
import type { PluginsTab } from '@settingsView/frontend/tabs/PluginsTab';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { PluginRow } from '@shared/settingsView/settingsViewMessages';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

useLitComponentTestDom(async () => {
  await import('@settingsView/frontend/tabs/ApprovalTab');
  await import('@settingsView/frontend/tabs/PluginsTab');
});

/** Flip the switch and fire its change, as a click would. */
function flip(toggle: HTMLElement & { checked?: boolean }): void {
  toggle.checked = !toggle.checked;
  toggle.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

describe('settings approval and plugins pages', () => {
  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('renders and updates working-directory path protection on the Approval page', async () => {
    const element = await mountComponent<ApprovalTab>('approval-tab', {
      toolPathProtectionEnabled: false,
    });
    const id = 'settings-toggle-restrict-tool-paths-to-the-working-directory';
    const toggle = element.shadowRoot?.querySelector<
      HTMLElement & { checked?: boolean }
    >(`wa-switch#${id}`);

    expect(toggle?.checked).toBe(false);
    // The <label for> is what names the control; a host aria-label never
    // reached the role-bearing input inside wa-switch's shadow root.
    expect(
      element.shadowRoot?.querySelector(`label[for="${id}"]`)?.textContent,
    ).toBe('Restrict tool paths to the working directory');
    flip(toggle!);
    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      { key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED, value: true },
    );
  });

  // Failure modes: a row's switch sends another kind's message (an installed
  // plugin toggled as a TeXRA tool id, or the reverse); an MCP server gets a
  // switch, making the page a second writer of mcp.json; a row with no
  // switch reads as off.
  it('gives each kind of row its own switch, and an MCP server none', async () => {
    const rows: PluginRow[] = [
      {
        kind: 'texra',
        item: {
          id: 'zotero',
          name: 'Zotero Integration',
          category: 'ai-agents',
          description: 'Zotero',
          tools: [{ name: 'zotero_search' }],
          status: 'available',
          requiresSetup: true,
          installActions: [],
          toggleable: true,
          enabled: false,
        },
        usedBy: ['assistant'],
      },
      {
        kind: 'installed',
        plugin: {
          name: 'lean-mathlib',
          source: 'github.com/acme/lean-mathlib',
          enabled: false,
          trusted: false,
          code: [],
          skillCount: 2,
          commandCount: 0,
          agentCount: 0,
          mcpServers: [],
        },
        usedBy: [],
      },
      {
        kind: 'mcp',
        name: 'arxiv-mcp',
        command: 'npx arxiv-mcp',
        usedBy: ['assistant'],
      },
    ];
    const element = await mountComponent<PluginsTab>('plugins-tab', {
      page: { rows, mcpConfigPath: '/home/u/.texra/mcp.json', mcpWarnings: [] },
    });
    const cards = [
      ...(element.shadowRoot?.querySelectorAll('plugin-card') ?? []),
    ];
    await Promise.all(cards.map((card) => card.updateComplete));
    const switchOf = (index: number) =>
      cards[index].shadowRoot?.querySelector<
        HTMLElement & { checked?: boolean }
      >('wa-switch') ?? null;

    expect(cards).toHaveLength(3);
    expect(switchOf(2)).toBeNull();
    expect(cards[2].shadowRoot?.textContent).toContain('Used by: assistant');

    flip(switchOf(0)!);
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
      { toolId: 'zotero', enabled: true },
    );
    flip(switchOf(1)!);
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION,
      { action: 'enable', name: 'lean-mathlib' },
    );
  });
});
