import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  MainViewExecuteInboundMessageSchema,
  type MainViewExecuteMessage,
} from '@shared/schemas/mainView/executeMessage';
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
        // Validate at the IPC boundary against the shared schema for this
        // command — the EXECUTE member of the main-view inbound union the
        // other desktop IPC handlers parse against — instead of blindly
        // casting untrusted renderer input.
        const parsed = MainViewExecuteInboundMessageSchema.safeParse(message);
        if (!parsed.success) {
          reportAsyncError(
            new Error(
              `Ignoring malformed ${MAIN_VIEW_COMMANDS.EXECUTE} message: ${parsed.error.message}`,
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
