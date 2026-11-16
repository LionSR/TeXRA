/**
 * Native application menu construction (main process only).
 *
 * The menu template is the one Electron-typed surface of the desktop
 * commands. It lives here, so the renderer's import graph never carries
 * Electron's `MenuItemConstructorOptions`. Its items carry no accelerator:
 * the renderer's shortcut registry handles the keys, so an editor or a
 * terminal sees them first.
 */

import {
  DESKTOP_LOCAL_COMMANDS,
  paletteEntries,
  type DesktopCommandId,
} from '../shared/desktopCommandSurface.js';
import { osPlatformOf } from '@texra/shared/osPlatform';

import type { MenuItemConstructorOptions } from 'electron';

/** The host's OS, as the command surface tells them apart; the renderer
 *  derives the same value from `navigator`. */
const HOST_PLATFORM = osPlatformOf(process.platform);

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
  run: (id: DesktopCommandId) => void,
  recent: DesktopRecentProjects,
): DesktopMenuTemplateItem[] {
  const entriesById = new Map(
    paletteEntries(HOST_PLATFORM).map((entry) => [entry.id, entry]),
  );
  const commandItem = (id: DesktopCommandId): DesktopMenuTemplateItem => {
    const entry = entriesById.get(id);
    if (!entry) throw new Error(`Missing desktop menu entry: ${id}`);
    return {
      label: entry.label,
      click: () => run(id),
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
      ...(HOST_PLATFORM === 'darwin'
        ? []
        : [settingsItem, { type: 'separator' as const }]),
      HOST_PLATFORM === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const leadingMenus: DesktopMenuTemplateItem[] =
    HOST_PLATFORM === 'darwin'
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
        commandItem(DESKTOP_LOCAL_COMMANDS.SHOW_BROWSER),
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
        commandItem(DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS),
        { type: 'separator' },
        commandItem(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
      ],
    },
  ];
}
