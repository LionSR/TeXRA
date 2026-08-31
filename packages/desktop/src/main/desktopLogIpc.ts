import {
  createCommandHandler,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';
import {
  DESKTOP_LOG_COMMANDS,
  type DesktopLogSnapshot,
} from '../shared/desktopLogMessages.js';

export interface DesktopLogIpcOptions {
  readLog(): DesktopLogSnapshot;
  copyLog(text: string): Promise<void>;
  exportLog(text: string): Promise<void>;
  onAsyncError?: (error: unknown) => void;
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

  return createCommandHandler(
    {
      [DESKTOP_LOG_COMMANDS.REQUEST_LOG]: () => {
        postSnapshot();
      },
      [DESKTOP_LOG_COMMANDS.COPY_LOG]: () =>
        options.copyLog(postSnapshot().text),
      [DESKTOP_LOG_COMMANDS.EXPORT_LOG]: () =>
        options.exportLog(postSnapshot().text),
    },
    { onAsyncError: options.onAsyncError },
  );
}
