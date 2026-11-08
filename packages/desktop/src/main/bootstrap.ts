import { app } from 'electron';

import { installDesktopAppLog } from './desktopAppLog.js';
import {
  installFatalStartupHandlers,
  installPostStartupRejectionHandler,
  reportFatalStartupError,
} from './fatalStartupError.js';

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
