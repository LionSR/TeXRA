import { Menu } from 'electron';

import { buildDesktopMenuTemplate } from './desktopCommandSurface.js';
import type { DesktopShellActions } from './desktopShellIpc.js';

export function installDesktopMenu(actions: DesktopShellActions): void {
  const template = buildDesktopMenuTemplate(actions);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
