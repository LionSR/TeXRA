/**
 * Console logging backend for CLI / Electron / tests.
 */
import type { LogBackend } from '../interfaces/log';

function timestamp(): string {
  const now = new Date();
  const p = (v: number, w = 2) => v.toString().padStart(w, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`;
}

export const consoleLog: LogBackend = {
  initialize() {},
  debug(ch, msg) {
    console.debug(`[${timestamp()}] [${ch}] ${msg}`);
  },
  info(ch, msg) {
    console.info(`[${timestamp()}] [${ch}] ${msg}`);
  },
  warn(ch, msg) {
    console.warn(`[${timestamp()}] [${ch}] ${msg}`);
  },
  error(ch, msg) {
    console.error(`[${timestamp()}] [${ch}] ${msg}`);
  },
};
