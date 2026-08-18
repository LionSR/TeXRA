// Third-party imports
import { describe, expect, it, vi, type Mock } from 'vitest';

// Type imports - desktop command surface
import type {
  DesktopCommandActions,
  DesktopCommandId,
} from '@desktop/shared/desktopCommandSurface';

// Local imports - command catalog and shared schemas
import {
  formatDesktopAccelerator,
  toElectronAccelerator,
} from '@shared/commands/accelerators';
import { commandCatalogById, type CommandId } from '@shared/commands/catalog';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.ts';

type MockedDesktopActions = Record<keyof DesktopCommandActions, Mock>;

/** Every dispatchable desktop command, with the shell action it must reach. */
const DESKTOP_DISPATCH_CASES: ReadonlyArray<
  [
    id: DesktopCommandId,
    action: keyof DesktopCommandActions,
    args: readonly unknown[],
  ]
> = [
  ['texra.showMainView', 'showLauncher', []],
  ['texra.desktop.showLogs', 'openWorkbench', ['logs']],
  ['texra.showDashboard', 'showSettings', []],
  ['texra.mainView.reset', 'resetMainView', []],
  ['texra.desktop.toggleBottomBar', 'toggleBottomBar', []],
  ['texra.desktop.toggleSidePanel', 'toggleSidePanel', []],
  ['texra.desktop.toggleSummaryBar', 'toggleSummaryBar', []],
  ['texra.showMemory', 'showSettings', ['memory']],
  ['texra.showModels', 'showSettings', ['models']],
  ['texra.showAgents', 'showSettings', ['agents']],
  ['texra.showTools', 'showSettings', ['tools']],
  ['texra.showMultiAgent', 'showSettings', ['multi-agent']],
  ['texra.showGitSettings', 'showSettings', ['git']],
  ['texra.desktop.openWorkspaceFolder', 'openWorkspaceFolder', []],
  ['texra.desktop.saveFile', 'saveFile', []],
  ['texra.desktop.openLogFolder', 'openLogFolder', []],
  ['texra.desktop.showFirstRunWalkthrough', 'showFirstRunWalkthrough', []],
  ['texra.desktop.openDesktopDocs', 'openDesktopDocs', []],
];

function makeDesktopActions(): MockedDesktopActions {
  return {
    openDesktopDocs: vi.fn(),
    openLogFolder: vi.fn(),
    openWorkbench: vi.fn(),
    openWorkspaceFolder: vi.fn(),
    resetMainView: vi.fn(),
    saveFile: vi.fn(),
    showFirstRunWalkthrough: vi.fn(),
    showLauncher: vi.fn(),
    showSettings: vi.fn(),
    showStream: vi.fn(),
    toggleBottomBar: vi.fn(),
    toggleSidePanel: vi.fn(),
    toggleSummaryBar: vi.fn(),
  };
}

describe('desktop command surface', () => {
  it('builds desktop menu entries from the shared command catalog', async () => {
    const {
      DESKTOP_COMMAND_IDS,
      DESKTOP_LOCAL_COMMANDS,
      getDesktopCommandMenuEntries,
    } = await loadSourceModule('@desktop/shared/desktopCommandSurface');
    const entries = getDesktopCommandMenuEntries('darwin');

    expect(entries.map((entry) => entry.id)).toEqual(DESKTOP_COMMAND_IDS);
    for (const entry of entries) {
      const catalogEntry = commandCatalogById.get(entry.id as CommandId);
      if (!catalogEntry) {
        if (entry.id === 'texra.desktop.showFirstRunWalkthrough') {
          expect(entry.category).toBe('Help');
          continue;
        }
        expect(['File', 'TeXRA', 'View', 'Help']).toContain(entry.category);
        continue;
      }
      expect(entry.label).toBe(catalogEntry.shortTitle ?? catalogEntry.title);
      expect(entry.category).toBe(catalogEntry.category);
    }
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          id: DESKTOP_LOCAL_COMMANDS.SAVE_FILE,
          label: 'Save',
          category: 'File',
          icon: 'floppy-disk',
          accelerator: 'Command+S',
        },
        {
          id: DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
          label: 'Open Folder',
          category: 'File',
          icon: 'folder-open',
          accelerator: 'Command+O',
        },
        {
          id: 'texra.showMainView',
          label: 'Show Launcher',
          category: 'TeXRA',
          icon: 'pencil',
          accelerator: 'Command+Option+M',
        },
        {
          id: DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
          label: 'Desktop Documentation',
          category: 'Help',
          icon: 'book',
        },
        {
          id: DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
          label: 'Show Logs',
          category: 'TeXRA',
          icon: 'file-lines',
        },
        {
          id: DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR,
          label: 'Toggle Bottom Bar',
          category: 'View',
          icon: 'window-maximize',
          accelerator: 'Command+J',
        },
        {
          id: DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL,
          label: 'Toggle Side Panel',
          category: 'View',
          icon: 'picture-in-picture',
          accelerator: 'Command+Alt+B',
        },
        {
          id: DESKTOP_LOCAL_COMMANDS.TOGGLE_SUMMARY_BAR,
          label: 'Toggle Summary Bar',
          category: 'View',
          icon: 'list-ul',
          accelerator: 'Command+Alt+S',
        },
      ]),
    );
    const firstHelpIndex = entries.findIndex(
      (entry) => entry.category === 'Help',
    );
    expect(firstHelpIndex).toBe(entries.length - 2);
    expect(
      entries.slice(firstHelpIndex).map((entry) => entry.category),
    ).toEqual(['Help', 'Help']);
  });

  it('normalizes catalog keybindings to Electron accelerators', () => {
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

  it('formats accelerators for desktop tooltip display', () => {
    expect(formatDesktopAccelerator('Command+Option+M', 'darwin')).toBe('⌘⌥M');
    expect(formatDesktopAccelerator('CommandOrControl+O', 'darwin')).toBe('⌘O');
    expect(formatDesktopAccelerator('CommandOrControl+O', 'linux')).toBe(
      'Ctrl+O',
    );
    expect(formatDesktopAccelerator('Control+Alt+Shift+C', 'linux')).toBe(
      'Ctrl+Alt+Shift+C',
    );
    expect(formatDesktopAccelerator(undefined, 'darwin')).toBeUndefined();
  });

  it.each(DESKTOP_DISPATCH_CASES)(
    '%s dispatches to actions.%s',
    async (id, action, args) => {
      const { dispatchDesktopCommand } = await loadSourceModule(
        '@desktop/shared/desktopCommandSurface',
      );
      const actions = makeDesktopActions();

      expect(dispatchDesktopCommand(id, actions)).toBe(true);
      expect(actions[action]).toHaveBeenCalledExactlyOnceWith(...args);
    },
  );

  it('offers no menu entry for VS Code-only commands', async () => {
    const { getDesktopCommandMenuEntries } = await loadSourceModule(
      '@desktop/shared/desktopCommandSurface',
    );
    const ids = getDesktopCommandMenuEntries().map((entry) => entry.id);

    for (const vscodeOnlyId of [
      'texra.execute',
      'texra.runSetupAssistant',
      'texra.showImportOptions',
      'texra.openGettingStarted',
      'texra.cleanOutput',
      'texra.cleanBuild',
    ]) {
      expect(ids).not.toContain(vscodeOnlyId);
    }
  });

  it('wires menu clicks to the catalog-backed dispatcher', async () => {
    const { buildDesktopMenuTemplate } = await loadSourceModule(
      '@desktop/main/desktopMenuTemplate',
    );
    const actions = makeDesktopActions();
    const menu = buildDesktopMenuTemplate(actions, 'darwin');

    expect(menu.map((item) => item.label ?? item.role)).toEqual([
      'appMenu',
      'File',
      'TeXRA',
      'editMenu',
      'viewMenu',
      'windowMenu',
      'Help',
    ]);
    const fileMenu = menu.find((item) => item.label === 'File');
    const fileSubmenu = fileMenu?.submenu ?? [];
    expect(
      fileSubmenu.map((item) => item.label ?? item.role ?? item.type),
    ).toEqual(['Save', 'Open Folder', 'separator', 'close']);
    fileSubmenu[0].click?.();
    expect(actions.saveFile).toHaveBeenCalledOnce();
    fileSubmenu[1].click?.();
    expect(actions.openWorkspaceFolder).toHaveBeenCalledOnce();

    const texraMenu = menu.find((item) => item.label === 'TeXRA');
    const submenu = texraMenu?.submenu ?? [];
    expect(submenu.map((item) => item.label ?? item.type)).toEqual([
      'Show Launcher',
      'Show Logs',
      'Open Logs Folder',
      'Settings',
      'Toggle Summary Bar',
      'Toggle Bottom Bar',
      'Toggle Side Panel',
      'New',
      'separator',
      'Show Memory',
      'Show Models',
      'Show Agents',
      'Show Tool Dashboard',
      'Show Multi-Agent Settings',
      'Show Git Settings',
    ]);
    const launcherItem = submenu.find((item) => item.label === 'Show Launcher');
    const modelsItem = submenu.find((item) => item.label === 'Show Models');
    launcherItem?.click?.();
    modelsItem?.click?.();
    expect(actions.showLauncher).toHaveBeenCalledOnce();
    expect(actions.showSettings).toHaveBeenCalledWith('models');

    const helpMenu = menu.find((item) => item.label === 'Help');
    const helpSubmenu = helpMenu?.submenu ?? [];
    expect(helpSubmenu.map((item) => item.label)).toEqual([
      'Show Startup Team Chooser',
      'Desktop Documentation',
    ]);
    helpSubmenu[0].click?.();
    expect(actions.showFirstRunWalkthrough).toHaveBeenCalledOnce();
    helpSubmenu[1].click?.();
    expect(actions.openDesktopDocs).toHaveBeenCalledOnce();
  });
});
