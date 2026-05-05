import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import {
  ProgressViewInboundMessageSchema,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';

import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopProgressBridge } from './desktopAgentExecution.js';

export interface DesktopProgressIpcOptions {
  progress: DesktopProgressBridge;
  onUnsupportedCommand?: (message: ProgressViewInboundMessage) => void;
  onAsyncError?: (error: unknown) => void;
}

export type DesktopProgressIpc = DesktopMessageHandler;

const passThroughCommands = new Set<string>([
  PROGRESS_VIEW_COMMANDS.WEBVIEW_READY,
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
    ((message) => {
      console.warn(`Unsupported desktop Progress command: ${message.command}`);
    });

  function runAsync(work: Promise<void>): void {
    void work.catch(reportAsyncError);
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const result = ProgressViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      switch (result.data.command) {
        case PROGRESS_VIEW_COMMANDS.WEBVIEW_READY:
          options.progress.syncFullView();
          return false;
        case PROGRESS_VIEW_COMMANDS.SWITCH_STREAM:
          options.progress.setActiveStream(result.data.stream);
          return true;
        case PROGRESS_VIEW_COMMANDS.FILTER_STREAMS:
          options.progress.setAgentFilter(result.data.filter);
          return true;
        case PROGRESS_VIEW_COMMANDS.DELETE_STREAM:
          runAsync(options.progress.deleteStream(result.data.stream));
          return true;
        case PROGRESS_VIEW_COMMANDS.DELETE_ALL:
          runAsync(options.progress.deleteAllStreams());
          return true;
        default:
          if (passThroughCommands.has(result.data.command)) return false;
          onUnsupportedCommand(result.data);
          return true;
      }
    },
  };
}
