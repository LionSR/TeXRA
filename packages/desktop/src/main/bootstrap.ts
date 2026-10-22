import { resolve as resolvePath } from 'node:path';
import { app } from 'electron';

import { installDesktopAppLog } from './desktopAppLog.js';
import {
  installFatalStartupHandlers,
  installPostStartupRejectionHandler,
  reportFatalStartupError,
} from './fatalStartupError.js';

// Playwright tests need a deterministic Electron profile so app-scoped stores
// survive across launches. Normal desktop launches keep Electron's default
// userData path. Set before the lock, which is held per profile.
const e2eUserDataPath = process.env.TEXRA_DESKTOP_E2E_USER_DATA_PATH;
if (e2eUserDataPath) {
  app.setPath('userData', resolvePath(e2eUserDataPath));
}

// One desktop process per profile. A second launch quits before it touches
// anything the running one owns: its log file (rotated on install) first.
if (app.requestSingleInstanceLock()) {
  installDesktopAppLog();
  const removeFatalStartupHandlers = installFatalStartupHandlers();
  try {
    await import('./index.js');
    removeFatalStartupHandlers();
    installPostStartupRejectionHandler();
  } catch (error) {
    reportFatalStartupError(error);
  }
} else {
  app.quit();
}
