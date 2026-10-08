import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@texra/shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type { ApprovalTab } from '@settingsView/frontend/tabs/ApprovalTab';
import type { PluginsTab } from '@settingsView/frontend/tabs/PluginsTab';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { PluginRow } from '@texra/shared/settingsView/settingsViewMessages';

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
    // The external label activates the host; the label slot also names the
    // role-bearing input inside wa-switch's shadow root.
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
    const catalog = element.shadowRoot!.querySelector('settings-catalog')!;
    await catalog.updateComplete;
    const select = async (index: number) => {
      const choices = catalog.shadowRoot!.querySelectorAll<HTMLElement>(
        '.catalog-row-select',
      );
      choices[index].click();
      await element.updateComplete;
      const card = element.shadowRoot!.querySelector('plugin-card')!;
      await card.updateComplete;
      return card;
    };
    const switchOf = (card: Awaited<ReturnType<typeof select>>) =>
      card.shadowRoot?.querySelector<HTMLElement & { checked?: boolean }>(
        'wa-switch',
      ) ?? null;
    const first = await select(0);
    flip(switchOf(first)!);
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
      { toolId: 'zotero', enabled: true },
    );
    flip(switchOf(await select(1))!);
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION,
      { action: 'enable', name: 'lean-mathlib' },
    );
    const mcp = await select(2);
    expect(switchOf(mcp)).toBeNull();
    expect(mcp.shadowRoot?.textContent).toContain('Used by: assistant');
    expect(element.shadowRoot?.querySelectorAll('plugin-card')).toHaveLength(1);
  });
});
