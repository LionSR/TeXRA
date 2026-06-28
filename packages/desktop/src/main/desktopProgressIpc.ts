import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import {
  dispatchProgressViewInbound,
  ProgressViewInboundMessageSchema,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';

import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopProgressBridge } from './desktopAgentExecution.js';

type DesktopProgressIpcBridge = Pick<
  DesktopProgressBridge,
  'progressViewInboundHandlers' | 'syncFullView'
>;

export interface DesktopProgressIpcOptions {
  progress?: DesktopProgressIpcBridge;
  getProgress?: () => DesktopProgressIpcBridge | undefined;
  ensureProgress?: () => Promise<DesktopProgressIpcBridge>;
  onUnsupportedCommand?: (message: ProgressViewInboundMessage) => void;
  onAsyncError?: (error: unknown) => void;
}

export type DesktopProgressIpc = DesktopMessageHandler;

const passThroughCommands = new Set<string>([
  PROGRESS_VIEW_COMMANDS.SWITCH_VIEW,
  PROGRESS_VIEW_COMMANDS.THEME_SET,
  PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET,
]);

export function createDesktopProgressIpc(
  options: DesktopProgressIpcOptions,
): DesktopProgressIpc {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);
  const onUnsupportedCommand =
    options.onUnsupportedCommand ??
    ((message: ProgressViewInboundMessage) =>
      console.warn(`Unsupported desktop Progress command: ${message.command}`));
  const getProgress = () => options.getProgress?.() ?? options.progress;
  const ensureProgress = options.ensureProgress;

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const result = ProgressViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      const command = result.data.command;
      // WEBVIEW_READY and pass-through commands return false so sibling
      // handlers in the chain still receive them.
      if (command === PROGRESS_VIEW_COMMANDS.WEBVIEW_READY) {
        const progress = getProgress();
        if (progress) {
          progress.syncFullView();
        } else if (ensureProgress) {
          void ensureProgress()
            .then((loaded) => loaded.syncFullView())
            .catch(reportAsyncError);
        }
        return false;
      }
      if (passThroughCommands.has(command)) return false;

      const progress = getProgress();
      if (!progress && ensureProgress) {
        void ensureProgress()
          .then((loaded) => {
            const handled = dispatchProgressViewInbound(
              message,
              loaded.progressViewInboundHandlers,
              reportAsyncError,
            );
            if (handled instanceof Promise) {
              void handled.catch(reportAsyncError);
              return;
            }
            if (handled) {
              return;
            }
            onUnsupportedCommand(result.data);
          })
          .catch(reportAsyncError);
        return true;
      }
      if (!progress) {
        onUnsupportedCommand(result.data);
        return true;
      }

      const handled = dispatchProgressViewInbound(
        message,
        progress.progressViewInboundHandlers,
        reportAsyncError,
      );
      if (handled instanceof Promise) {
        void handled.catch(reportAsyncError);
        return true;
      }
      if (handled) {
        return true;
      }
      // Recognized but unhandled command: consume it with a warning.
      onUnsupportedCommand(result.data);
      return true;
    },
  };
}
