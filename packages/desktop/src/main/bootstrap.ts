import { installDesktopAppLog } from './desktopAppLog.js';
import {
  installFatalStartupHandlers,
  reportFatalStartupError,
} from './fatalStartupError.js';

installDesktopAppLog();

const removeFatalStartupHandlers = installFatalStartupHandlers();
try {
  await import('./index.js');
  removeFatalStartupHandlers();
} catch (error) {
  reportFatalStartupError(error);
}
