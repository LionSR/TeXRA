import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import { MainViewInboundMessageSchema } from '@shared/schemas/mainView';
import {
  createCommandHandler,
  createDesktopErrorReporter,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';

export interface DesktopExecutionIpcOptions {
  executeAgent(message: MainViewExecuteMessage): Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export function createDesktopExecutionIpc(
  options: DesktopExecutionIpcOptions,
): DesktopMessageHandler {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  return createCommandHandler(
    {
      [MAIN_VIEW_COMMANDS.EXECUTE]: (message) => {
        // Validate at the IPC boundary against the shared inbound schema
        // (the same schema desktopShellIpc/desktopProgressIpc/desktopSettingsIpc
        // parse against) instead of blindly casting untrusted renderer input.
        const parsed = MainViewInboundMessageSchema.safeParse(message);
        if (
          !parsed.success ||
          parsed.data.command !== MAIN_VIEW_COMMANDS.EXECUTE
        ) {
          reportAsyncError(
            new Error(
              `Ignoring malformed ${MAIN_VIEW_COMMANDS.EXECUTE} message: ${
                parsed.success
                  ? `unexpected command ${String(parsed.data.command)}`
                  : parsed.error.message
              }`,
            ),
          );
          return;
        }
        return options.executeAgent(parsed.data);
      },
    },
    { onAsyncError: options.onAsyncError },
  );
}
