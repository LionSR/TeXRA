import { Menu, type MenuItemConstructorOptions } from 'electron';

import { buildDesktopMenuTemplate } from './desktopCommandSurface.js';
import type { DesktopShellActions } from './desktopShellIpc.js';

export function installDesktopMenu(actions: DesktopShellActions): void {
  const template = buildDesktopMenuTemplate(
    actions,
  ) as MenuItemConstructorOptions[];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
