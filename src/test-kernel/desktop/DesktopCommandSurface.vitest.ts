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
    toggleBottomBar: vi.fn(),
    toggleSidePanel: vi.fn(),
    toggleSummaryBar: vi.fn(),
  };
}

describe('desktop command surface', () => {
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
    expect(formatDesktopAccelerator('Control+O', 'linux')).toBe('Ctrl+O');
    expect(formatDesktopAccelerator('Control+Alt+Shift+C', 'linux')).toBe(
      'Ctrl+Alt+Shift+C',
    );
    expect(formatDesktopAccelerator(undefined, 'darwin')).toBeUndefined();
  });
});
