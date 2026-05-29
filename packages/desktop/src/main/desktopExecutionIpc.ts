import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';
import {
  createCommandHandler,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { MainViewExecuteMessage } from '@controllers/mainView/MainViewExecutionController';

export interface DesktopExecutionIpcOptions {
  executeAgent?: (message: MainViewExecuteMessage) => Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export function createDesktopExecutionIpc(
  options: DesktopExecutionIpcOptions = {},
): DesktopMessageHandler {
  return createCommandHandler(
    {
      [MAIN_VIEW_COMMANDS.EXECUTE]: (message) =>
        options.executeAgent?.(message as MainViewExecuteMessage),
    },
    { onAsyncError: options.onAsyncError },
  );
}
