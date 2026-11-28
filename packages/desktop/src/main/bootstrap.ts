import { enableCompileCache } from 'node:module';
import { join } from 'node:path';

import { app } from 'electron';

// One desktop process per profile. A second launch quits before it touches
// anything the running one owns: its log file (rotated on install) first.
if (app.requestSingleInstanceLock()) {
  // Before any other module of the bundle loads: a launch after the first
  // reads V8's compiled code for the bundle from the profile and skips
  // compiling it. A cache that cannot be used is not an error; the bundle
  // compiles as it would without one.
  enableCompileCache(join(app.getPath('userData'), 'compile-cache'));
  const [
    { installDesktopAppLog },
    {
      installFatalStartupHandlers,
      installPostStartupRejectionHandler,
      reportFatalStartupError,
    },
  ] = await Promise.all([
    import('./desktopAppLog.js'),
    import('./fatalStartupError.js'),
  ]);
  installDesktopAppLog();
  const removeFatalStartupHandlers = installFatalStartupHandlers();
  try {
    const { startDesktop } = await import('./index.js');
    startDesktop(import.meta.dirname);
    removeFatalStartupHandlers();
    installPostStartupRejectionHandler();
  } catch (error) {
    reportFatalStartupError(error);
  }
} else {
  app.quit();
}
