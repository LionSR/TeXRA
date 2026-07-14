// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - command catalog and shared schemas
import { toElectronAccelerator } from '@shared/commands/accelerators';
import { commandCatalogById, type CommandId } from '@shared/commands/catalog';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

type DesktopCommandSurfaceModule =
  typeof import('@desktop/desktopCommandSurface');

async function loadDesktopCommandSurface(): Promise<DesktopCommandSurfaceModule> {
  return import(
    moduleFileUrl(desktopSourcePath('desktopCommandSurface.ts'))
  ) as Promise<DesktopCommandSurfaceModule>;
}

describe('desktop command surface', () => {
  it('builds desktop menu entries from the shared command catalog', async () => {
    const {
      DESKTOP_COMMAND_IDS,
      DESKTOP_LOCAL_COMMANDS,
      getDesktopCommandMenuEntries,
    } = await loadDesktopCommandSurface();
    const entries = getDesktopCommandMenuEntries(undefined, 'darwin');

    expect(entries.map((entry) => entry.id)).toEqual(DESKTOP_COMMAND_IDS);
    for (const entry of entries) {
      const catalogEntry = commandCatalogById.get(entry.id as CommandId);
      if (!catalogEntry) {
        if (entry.id === 'texra.desktop.showFirstRunWalkthrough') {
          expect(entry.category).toBe('Help');
          continue;
        }
        expect(['File', 'TeXRA', 'Help']).toContain(entry.category);
        continue;
      }
      expect(entry.label).toBe(catalogEntry.shortTitle ?? catalogEntry.title);
      expect(entry.category).toBe(catalogEntry.category);
    }
    expect(entries).toContainEqual({
      id: DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
      label: 'Open Folder',
      category: 'File',
      accelerator: 'Command+O',
      enabled: true,
    });
    expect(entries).toContainEqual({
      id: DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW,
      label: 'New Window',
      category: 'File',
      accelerator: 'Command+Shift+N',
      enabled: true,
    });
    expect(entries).toContainEqual({
      id: 'texra.showMainView',
      label: 'Show Launcher',
      category: 'TeXRA',
      accelerator: 'Command+Option+M',
      enabled: true,
    });
    expect(entries).toContainEqual({
      id: 'texra.showProgressView',
      label: 'Show Progress',
      category: 'TeXRA',
      accelerator: 'Command+Option+P',
      enabled: true,
    });
    expect(entries).toContainEqual({
      id: DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS,
      label: 'Desktop Documentation',
      category: 'Help',
      enabled: true,
    });
    expect(entries).toContainEqual({
      id: DESKTOP_LOCAL_COMMANDS.SHOW_LOGS,
      label: 'Show Logs',
      category: 'TeXRA',
      enabled: true,
    });
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

  it('formats accelerators for desktop tooltip display', async () => {
    const { formatDesktopAccelerator } = await loadDesktopCommandSurface();

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

  it('dispatches supported commands through typed shell actions', async () => {
    const { DESKTOP_LOCAL_COMMANDS, dispatchDesktopCommand } =
      await loadDesktopCommandSurface();
    const actions = {
      openDesktopDocs: vi.fn(),
      openLogFolder: vi.fn(),
      openWorkspaceFolder: vi.fn(),
      openWorkspaceInNewWindow: vi.fn(),
      showFirstRunWalkthrough: vi.fn(),
      resetMainView: vi.fn(),
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };

    expect(dispatchDesktopCommand('texra.showMainView', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.showProgressView', actions)).toBe(
      true,
    );
    expect(
      dispatchDesktopCommand(DESKTOP_LOCAL_COMMANDS.SHOW_LOGS, actions),
    ).toBe(true);
    expect(dispatchDesktopCommand('texra.openSettings', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.mainView.reset', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.showModels', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.showAgents', actions)).toBe(true);
    expect(dispatchDesktopCommand('texra.showGitSettings', actions)).toBe(true);
    expect(
      dispatchDesktopCommand(
        DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER,
        actions,
      ),
    ).toBe(true);
    expect(
      dispatchDesktopCommand(
        DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_IN_NEW_WINDOW,
        actions,
      ),
    ).toBe(true);
    expect(
      dispatchDesktopCommand(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER, actions),
    ).toBe(true);
    expect(
      dispatchDesktopCommand(
        DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH,
        actions,
      ),
    ).toBe(true);
    expect(
      dispatchDesktopCommand(DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS, actions),
    ).toBe(true);

    expect(actions.showRoute).toHaveBeenNthCalledWith(1, 'main');
    expect(actions.showRoute).toHaveBeenNthCalledWith(2, 'progress');
    expect(actions.showRoute).toHaveBeenNthCalledWith(3, 'logs');
    expect(actions.showSettings).toHaveBeenNthCalledWith(1);
    expect(actions.showSettings).toHaveBeenNthCalledWith(
      2,
      SETTINGS_TAB.MODELS,
    );
    expect(actions.showSettings).toHaveBeenNthCalledWith(
      3,
      SETTINGS_TAB.AGENTS,
    );
    expect(actions.showSettings).toHaveBeenNthCalledWith(4, SETTINGS_TAB.GIT);
    expect(actions.resetMainView).toHaveBeenCalledOnce();
    expect(actions.openWorkspaceFolder).toHaveBeenCalledOnce();
    expect(actions.openWorkspaceInNewWindow).toHaveBeenCalledOnce();
    expect(actions.openLogFolder).toHaveBeenCalledOnce();
    expect(actions.showFirstRunWalkthrough).toHaveBeenCalledOnce();
    expect(
      commandCatalogById.has(
        DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH as CommandId,
      ),
    ).toBe(false);
    expect(actions.openDesktopDocs).toHaveBeenCalledOnce();
  });

  it('marks VS Code-only commands as unavailable instead of clickable no-ops', async () => {
    const { dispatchDesktopCommand, getDesktopCommandMenuEntries } =
      await loadDesktopCommandSurface();
    const actions = {
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };
    const entries = getDesktopCommandMenuEntries();
    const executeEntry = entries.find((entry) => entry.id === 'texra.execute');

    expect(executeEntry).toMatchObject({
      enabled: false,
      unavailableReason:
        'Use the Launcher execute button after choosing an agent and files.',
    });
    expect(dispatchDesktopCommand('texra.execute', actions)).toBe(false);
    expect(actions.showRoute).not.toHaveBeenCalled();
    expect(actions.showSettings).not.toHaveBeenCalled();
  });

  it('wires menu clicks to the catalog-backed dispatcher', async () => {
    const { buildDesktopMenuTemplate } = await loadDesktopCommandSurface();
    const actions = {
      openDesktopDocs: vi.fn(),
      openWorkspaceFolder: vi.fn(),
      openWorkspaceInNewWindow: vi.fn(),
      resetMainView: vi.fn(),
      showFirstRunWalkthrough: vi.fn(),
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };
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
    ).toEqual(['Open Folder', 'New Window', 'separator', 'close']);
    fileSubmenu[0].click?.();
    fileSubmenu[1].click?.();
    expect(actions.openWorkspaceFolder).toHaveBeenCalledOnce();
    expect(actions.openWorkspaceInNewWindow).toHaveBeenCalledOnce();

    const texraMenu = menu.find((item) => item.label === 'TeXRA');
    const submenu = texraMenu?.submenu ?? [];
    expect(submenu.map((item) => item.label ?? item.type)).toEqual([
      'Show Launcher',
      'Show Progress',
      'Show Logs',
      'Open Logs Folder',
      'Open TeXRA Settings',
      'New',
      'separator',
      'Execute Agent',
      'Run Setup Assistant Agent (Setup Wizard)',
      'Import or Create LaTeX Project',
      'Show Memory',
      'Show Agent Execution History',
      'Show Models',
      'Show Agents',
      'Show Tool Dashboard',
      'Show Multi-Agent Settings',
      'Show Git Settings',
      'Open Getting Started Walkthrough',
      'Clean LLM Outputs',
      'Clean Build Files',
    ]);
    const launcherItem = submenu.find((item) => item.label === 'Show Launcher');
    const executeItem = submenu.find((item) => item.label === 'Execute Agent');
    const modelsItem = submenu.find((item) => item.label === 'Show Models');
    launcherItem?.click?.();
    executeItem?.click?.();
    modelsItem?.click?.();
    expect(actions.showRoute).toHaveBeenCalledWith('main');
    expect(actions.showSettings).toHaveBeenCalledWith(SETTINGS_TAB.MODELS);
    expect(executeItem).toMatchObject({
      enabled: false,
      toolTip:
        'Use the Launcher execute button after choosing an agent and files.',
    });

    const helpMenu = menu.find((item) => item.label === 'Help');
    const helpSubmenu = helpMenu?.submenu ?? [];
    expect(helpSubmenu.map((item) => item.label)).toEqual([
      'Show First-Run Walkthrough',
      'Desktop Documentation',
    ]);
    helpSubmenu[0].click?.();
    expect(actions.showFirstRunWalkthrough).toHaveBeenCalledOnce();
    helpSubmenu[1].click?.();
    expect(actions.openDesktopDocs).toHaveBeenCalledOnce();
  });
});
