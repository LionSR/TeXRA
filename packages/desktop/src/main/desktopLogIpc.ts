import {
  createCommandHandler,
  createDesktopErrorReporter,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';
import {
  DESKTOP_LOG_COMMANDS,
  type DesktopLogSnapshot,
} from '../desktopLogMessages.js';

export interface DesktopLogIpcOptions {
  readLog?: () => DesktopLogSnapshot;
  copyLog?: (text: string) => Promise<void>;
  exportLog?: (text: string) => Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export function createDesktopLogIpc(
  renderer: DesktopRenderer,
  options: DesktopLogIpcOptions = {},
): DesktopMessageHandler {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  function readSnapshot(): DesktopLogSnapshot {
    return (
      options.readLog?.() ?? {
        path: undefined,
        text: 'Desktop log is not available.',
        truncated: false,
      }
    );
  }

  function postSnapshot(): DesktopLogSnapshot {
    const log = readSnapshot();
    renderer.postToRenderer({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log,
    });
    return log;
  }

  function copyLog() {
    const log = postSnapshot();
    void options.copyLog?.(log.text).catch(reportAsyncError);
  }

  function exportLog() {
    const log = postSnapshot();
    void options.exportLog?.(log.text).catch(reportAsyncError);
  }

  return createCommandHandler(
    {
      [DESKTOP_LOG_COMMANDS.REQUEST_LOG]: () => {
        postSnapshot();
      },
      [DESKTOP_LOG_COMMANDS.COPY_LOG]: () => copyLog(),
      [DESKTOP_LOG_COMMANDS.EXPORT_LOG]: () => exportLog(),
    },
    { onAsyncError: options.onAsyncError },
  );
}
