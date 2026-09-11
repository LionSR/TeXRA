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
  onAsyncError: (error: unknown) => void;
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
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case DESKTOP_LOG_COMMANDS.REQUEST_LOG:
          postSnapshot();
          return true;
        case DESKTOP_LOG_COMMANDS.COPY_LOG:
          options.copyLog(postSnapshot().text).catch(options.onAsyncError);
          return true;
        case DESKTOP_LOG_COMMANDS.EXPORT_LOG:
          options.exportLog(postSnapshot().text).catch(options.onAsyncError);
          return true;
        default:
          return false;
      }
    },
  };
}
