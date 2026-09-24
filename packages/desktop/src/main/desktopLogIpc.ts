import { Effect } from 'effect';

import { ensureError } from '@utils/errors/errorMessage';

import {
  DESKTOP_LOG_COMMANDS,
  type DesktopLogSnapshot,
} from '../shared/desktopLogMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';

export interface DesktopLogIpcOptions {
  readLog(): DesktopLogSnapshot;
  copyLog(text: string): Promise<void>;
  exportLog(text: string): Promise<void>;
}

export function createDesktopLogIpc(
  renderer: DesktopRenderer,
  options: DesktopLogIpcOptions,
): DesktopMessageHandler {
  function postSnapshot(): DesktopLogSnapshot {
    const log = options.readLog();
    renderer.postToRenderer({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log,
    });
    return log;
  }

  return {
    handleMessage(message: DesktopCommandMessage) {
      switch (message.command) {
        case DESKTOP_LOG_COMMANDS.REQUEST_LOG:
          return Effect.sync(postSnapshot);
        case DESKTOP_LOG_COMMANDS.COPY_LOG:
          return Effect.tryPromise({
            try: () => options.copyLog(postSnapshot().text),
            catch: ensureError,
          });
        case DESKTOP_LOG_COMMANDS.EXPORT_LOG:
          return Effect.tryPromise({
            try: () => options.exportLog(postSnapshot().text),
            catch: ensureError,
          });
        default:
          return undefined;
      }
    },
  };
}
