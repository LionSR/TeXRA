// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - command catalog
import { commandCatalogById, type CommandId } from '@commands/catalog';

// Local imports - webview commands
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';

// Local imports - shared schemas
import { AGENT_CATEGORY } from '@shared/schemas/agent';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import type { DesktopCommandActions } from '../../../packages/desktop/src/desktopCommandSurface';

interface DesktopCommandSurfaceModule {
  DESKTOP_COMMAND_IDS: readonly string[];
  buildDesktopMenuTemplate(
    actions: DesktopCommandActions,
    platform?: NodeJS.Platform,
  ): Array<{
    label?: string;
    role?: string;
    submenu?: DesktopMenuItem[];
  }>;
  dispatchDesktopCommand(id: string, actions: DesktopCommandActions): boolean;
  getDesktopCommandMenuEntries(
    ids?: readonly string[],
    platform?: NodeJS.Platform,
  ): Array<{
    id: string;
    label: string;
    category: string;
    accelerator?: string;
  }>;
  toElectronAccelerator(
    keybinding: { key: string; mac?: string },
    platform?: NodeJS.Platform,
  ): string;
  buildDesktopSettingsTabMessage(
    tabIndex: number,
    agentSubTab?: string,
  ): {
    command: string;
    tabIndex: number;
    agentSubTab?: string;
  };
}

interface DesktopMenuItem {
  label?: string;
  accelerator?: string;
  submenu?: DesktopMenuItem[];
  type?: 'separator';
  click?: () => void;
}

async function loadDesktopCommandSurface(): Promise<DesktopCommandSurfaceModule> {
  return import(
    moduleFileUrl(desktopSourcePath('desktopCommandSurface.ts'))
  ) as Promise<DesktopCommandSurfaceModule>;
}

describe('desktop command surface', () => {
  it('builds desktop menu entries from the shared command catalog', async () => {
    const { DESKTOP_COMMAND_IDS, getDesktopCommandMenuEntries } =
      await loadDesktopCommandSurface();
    const entries = getDesktopCommandMenuEntries(undefined, 'darwin');

    expect(entries.map((entry) => entry.id)).toEqual(DESKTOP_COMMAND_IDS);
    for (const entry of entries) {
      const catalogEntry = commandCatalogById.get(entry.id as CommandId);
      if (!catalogEntry) {
        expect(entry.category).toBe('TeXRA');
        continue;
      }
      expect(catalogEntry).toBeDefined();
      expect(entry.label).toBe(catalogEntry?.shortTitle ?? catalogEntry?.title);
      expect(entry.category).toBe(catalogEntry?.category);
    }
    expect(entries).toContainEqual({
      id: 'texra.showMainView',
      label: 'Show Launcher',
      category: 'TeXRA',
      accelerator: 'Command+Option+M',
    });
    expect(entries).toContainEqual({
      id: 'texra.showProgressView',
      label: 'Show Progress',
      category: 'TeXRA',
      accelerator: 'Command+Option+P',
    });
  });

  it('normalizes catalog keybindings to Electron accelerators', async () => {
    const { toElectronAccelerator } = await loadDesktopCommandSurface();

    expect(
      toElectronAccelerator(
        { key: 'ctrl+alt+shift+c', mac: 'cmd+option+shift+c' },
        'darwin',
      ),
    ).toBe('Command+Option+Shift+C');
    expect(
      toElectronAccelerator(
        { key: 'ctrl+alt+shift+c', mac: 'cmd+option+shift+c' },
        'linux',
      ),
    ).toBe('Control+Alt+Shift+C');
  });

  it('dispatches supported commands through typed shell actions', async () => {
    const { dispatchDesktopCommand } = await loadDesktopCommandSurface();
    const actions = {
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };

    expect(dispatchDesktopCommand('texra.showMainView', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.showProgressView', actions)).toBe(
      true,
    );
    expect(dispatchDesktopCommand('texra.openSettings', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.showModels', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.showAgents', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.execute', actions)).toBe(false);

    expect(actions.showRoute).toHaveBeenNthCalledWith(1, 'main');
    expect(actions.showRoute).toHaveBeenNthCalledWith(2, 'progress');
    expect(actions.showSettings).toHaveBeenNthCalledWith(1);
    expect(actions.showSettings).toHaveBeenNthCalledWith(
      2,
      SETTINGS_TAB.MODELS,
    );
    expect(actions.showSettings).toHaveBeenNthCalledWith(
      3,
      SETTINGS_TAB.AGENTS,
    );
  });

  it('builds settings-tab messages from one shared helper', async () => {
    const { buildDesktopSettingsTabMessage } =
      await loadDesktopCommandSurface();

    expect(buildDesktopSettingsTabMessage(SETTINGS_TAB.MODELS)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.MODELS,
    });
    expect(
      buildDesktopSettingsTabMessage(
        SETTINGS_TAB.AGENTS,
        AGENT_CATEGORY.TOOL_USE,
      ),
    ).toEqual({
      agentSubTab: AGENT_CATEGORY.TOOL_USE,
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.AGENTS,
    });
  });

  it('wires menu clicks to the catalog-backed dispatcher', async () => {
    const { buildDesktopMenuTemplate } = await loadDesktopCommandSurface();
    const actions = {
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };
    const menu = buildDesktopMenuTemplate(actions, 'darwin');

    expect(menu.map((item) => item.label ?? item.role)).toEqual([
      'appMenu',
      'fileMenu',
      'TeXRA',
      'editMenu',
      'viewMenu',
      'windowMenu',
      'help',
    ]);
    const texraMenu = menu.find((item) => item.label === 'TeXRA');
    const submenu = texraMenu?.submenu ?? [];
    expect(submenu.map((item) => item.label ?? item.type)).toEqual([
      'Show Launcher',
      'Show Progress',
      'Open Folder',
      'Open Logs Folder',
      'Open TeXRA Settings',
      'separator',
      'Show Memory',
      'Show Agent Execution History',
      'Show Models',
      'Show Agents',
      'Show Tool Dashboard',
      'Show Multi-Agent Settings',
    ]);

    submenu[0].click?.();
    submenu[8].click?.();
    expect(actions.showRoute).toHaveBeenCalledWith('main');
    expect(actions.showSettings).toHaveBeenCalledWith(SETTINGS_TAB.MODELS);
  });
});
