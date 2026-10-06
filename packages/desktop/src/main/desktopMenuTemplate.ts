/**
 * Native application menu construction (main process only).
 *
 * The menu template is the one Electron-typed surface of the desktop command
 * registry. It lives here — and only here — so the renderer's import graph
 * never nominally carries Electron's `MenuItemConstructorOptions`; the shared
 * `desktopCommandSurface.ts` stays a pure command registry both processes
 * import for dispatch and palette rendering.
 */

import type { DesktopPlatform } from '@shared/commands/accelerators';

import {
  DESKTOP_HELP_COMMANDS,
  DESKTOP_LOCAL_COMMANDS,
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../shared/desktopCommandSurface.js';
import type { MenuItemConstructorOptions } from 'electron';

/** The one place Electron's wider platform id is narrowed into the union the
 *  command surface speaks; the renderer derives the same value from
 *  `navigator`. */
const HOST_PLATFORM: DesktopPlatform = ((): DesktopPlatform => {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
})();

/** Menu template shape produced before Electron materializes native menus. */
interface DesktopMenuTemplateItem extends Omit<
  MenuItemConstructorOptions,
  'click' | 'submenu'
> {
  click?: () => void;
  submenu?: DesktopMenuTemplateItem[];
}

/** File > Open Recent: the closed projects the registry remembers. */
interface DesktopRecentProjects {
  readonly roots: readonly string[];
  open(root: string): void;
  clear(): void;
}

function openRecentMenu(
  recent: DesktopRecentProjects,
): DesktopMenuTemplateItem {
  return {
    label: 'Open Recent',
    submenu:
      recent.roots.length === 0
        ? [{ label: 'No Recent Projects', enabled: false }]
        : [
            ...recent.roots.map((root) => ({
              label: root,
              click: () => recent.open(root),
            })),
            { type: 'separator' },
            { label: 'Clear Recent', click: () => recent.clear() },
          ],
  };
}

export function buildDesktopMenuTemplate(
  actions: DesktopCommandActions,
  recent: DesktopRecentProjects,
  platform: DesktopPlatform = HOST_PLATFORM,
): DesktopMenuTemplateItem[] {
  const entriesById = new Map(
    getDesktopCommandMenuEntries(platform).map((entry) => [entry.id, entry]),
  );
  const commandItem = (id: DesktopCommandId): DesktopMenuTemplateItem => {
    const entry = entriesById.get(id);
    if (!entry) throw new Error(`Missing desktop menu entry: ${id}`);
    return {
      label: entry.label,
      click: () => dispatchDesktopCommand(id, actions),
    };
  };
  const settingsItem = {
    ...commandItem('texra.showDashboard'),
    label: 'Settings…',
  };
  const fileMenu: DesktopMenuTemplateItem = {
    label: 'File',
    submenu: [
      commandItem('texra.showMainView'),
      commandItem(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
      openRecentMenu(recent),
      { type: 'separator' },
      commandItem(DESKTOP_LOCAL_COMMANDS.SAVE_FILE),
      ...(platform === 'darwin'
        ? []
        : [settingsItem, { type: 'separator' as const }]),
      platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const leadingMenus: DesktopMenuTemplateItem[] =
    platform === 'darwin'
      ? [
          {
            role: 'appMenu',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          fileMenu,
        ]
      : [fileMenu];

  return [
    ...leadingMenus,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        commandItem(DESKTOP_LOCAL_COMMANDS.TOGGLE_SIDE_PANEL),
        commandItem(DESKTOP_LOCAL_COMMANDS.TOGGLE_BOTTOM_BAR),
        commandItem(DESKTOP_LOCAL_COMMANDS.SHOW_LOGS),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        ...DESKTOP_HELP_COMMANDS.map(commandItem),
        { type: 'separator' },
        commandItem(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
      ],
    },
  ];
}
