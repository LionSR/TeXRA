/**
 * Native application menu construction (main process only).
 *
 * The menu template is the one Electron-typed surface of the desktop command
 * registry. It lives here — and only here — so the renderer's import graph
 * never nominally carries Electron's `MenuItemConstructorOptions`; the shared
 * `desktopCommandSurface.ts` stays a pure command registry both processes
 * import for dispatch and palette rendering.
 */

import type { MenuItemConstructorOptions } from 'electron';

import {
  DESKTOP_FILE_COMMANDS,
  DESKTOP_HELP_COMMANDS,
  DESKTOP_MENU_GROUPS,
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
  type DesktopCommandActions,
  type DesktopCommandId,
} from '../shared/desktopCommandSurface.js';

/** Menu template shape produced before Electron materializes native menus. */
export interface DesktopMenuTemplateItem extends Omit<
  MenuItemConstructorOptions,
  'click' | 'submenu'
> {
  click?: () => void;
  submenu?: DesktopMenuTemplateItem[];
}

export function buildDesktopMenuTemplate(
  actions: DesktopCommandActions,
  platform: NodeJS.Platform = process.platform,
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
  const customMenu: DesktopMenuTemplateItem = {
    label: 'TeXRA',
    submenu: [
      ...DESKTOP_MENU_GROUPS[0].map(commandItem),
      { type: 'separator' },
      ...DESKTOP_MENU_GROUPS[1].map(commandItem),
    ],
  };
  const fileMenu: DesktopMenuTemplateItem = {
    label: 'File',
    submenu: [
      ...DESKTOP_FILE_COMMANDS.map(commandItem),
      { type: 'separator' },
      platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  };

  const leadingMenus: DesktopMenuTemplateItem[] =
    platform === 'darwin' ? [{ role: 'appMenu' }, fileMenu] : [fileMenu];

  return [
    ...leadingMenus,
    customMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      role: 'help',
      submenu: DESKTOP_HELP_COMMANDS.map(commandItem),
    },
  ];
}
