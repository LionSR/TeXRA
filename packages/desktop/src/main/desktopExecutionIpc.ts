import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
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
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      if (message.command !== MAIN_VIEW_COMMANDS.EXECUTE) return false;
      if (!options.executeAgent) return true;
      void options
        .executeAgent(message as MainViewExecuteMessage)
        .catch(reportAsyncError);
      return true;
    },
  };
}
