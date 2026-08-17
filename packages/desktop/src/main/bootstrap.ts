import { installDesktopAppLog } from './desktopAppLog.js';
import {
  installFatalStartupHandlers,
  installPostStartupRejectionHandler,
  reportFatalStartupError,
} from './fatalStartupError.js';

installDesktopAppLog();

const removeFatalStartupHandlers = installFatalStartupHandlers();
try {
  await import('./index.js');
  removeFatalStartupHandlers();
  installPostStartupRejectionHandler();
} catch (error) {
  reportFatalStartupError(error);
}
