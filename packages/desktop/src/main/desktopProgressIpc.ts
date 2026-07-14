import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchProgressViewInbound,
  ProgressViewInboundMessageSchema,
  type ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import { UnsupportedCommandError } from '@shared/utils/dispatcher';

import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopProgressBridge } from './desktopAgentExecution.js';

type DesktopProgressIpcBridge = Pick<
  DesktopProgressBridge,
  'progressViewInboundHandlers' | 'completeWebviewReady'
>;

export interface DesktopProgressIpcOptions {
  progress?: DesktopProgressIpcBridge;
  getProgress?: () => DesktopProgressIpcBridge | undefined;
  ensureProgress?: () => Promise<DesktopProgressIpcBridge>;
  /** Called for a recognized command that wasn't dispatched to a real
   *  handler — either the matched registry entry is `unsupported(...)`
   *  (`reason` set to its message), or the progress bridge isn't
   *  constructed yet (`reason` undefined). A schema-invalid message never
   *  reaches this callback; `handleMessage` returns `false` for it instead. */
  onUnsupportedCommand?: (
    message: ProgressViewInboundMessage,
    reason?: string,
  ) => void;
  onAsyncError?: (error: unknown) => void;
}

export type DesktopProgressIpc = DesktopMessageHandler;

const passThroughCommands = new Set<string>([
  PROGRESS_VIEW_COMMANDS.SWITCH_VIEW,
  PROGRESS_VIEW_COMMANDS.THEME_SET,
  PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET,
]);

function isProgressWebviewReadyMessage(
  message: DesktopCommandMessage,
): boolean {
  return (
    message.command === PROGRESS_VIEW_COMMANDS.WEBVIEW_READY &&
    message.view === 'progress'
  );
}

export function createDesktopProgressIpc(
  options: DesktopProgressIpcOptions,
): DesktopProgressIpc {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);
  const onUnsupportedCommand =
    options.onUnsupportedCommand ??
    ((message: ProgressViewInboundMessage, reason?: string) =>
      console.warn(
        `Unsupported desktop Progress command: ${message.command}${reason ? ` (${reason})` : ''}`,
      ));
  const getProgress = () => options.getProgress?.() ?? options.progress;
  const ensureProgress = options.ensureProgress;

  // Splits a dispatch's onError callback: an UnsupportedCommandError (a
  // registry entry declared `unsupported(...)`) is captured for
  // onUnsupportedCommand's visible feedback below instead of being logged
  // as a generic error.
  function dispatchAndReport(
    message: DesktopCommandMessage,
    handlers: Parameters<typeof dispatchProgressViewInbound>[1],
    parsed: ProgressViewInboundMessage,
  ): boolean {
    let unsupportedReason: string | undefined;
    const handled = dispatchProgressViewInbound(message, handlers, (error) => {
      if (error instanceof UnsupportedCommandError) {
        unsupportedReason = error.reason;
        return;
      }
      reportAsyncError(error);
    });
    if (!handled) onUnsupportedCommand(parsed, unsupportedReason);
    return handled;
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const result = ProgressViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      const command = result.data.command;
      // WEBVIEW_READY and pass-through commands return false so sibling
      // handlers in the chain still receive them.
      if (command === PROGRESS_VIEW_COMMANDS.WEBVIEW_READY) {
        if (!isProgressWebviewReadyMessage(message)) return false;
        const progress = getProgress();
        if (progress) {
          void progress.completeWebviewReady().catch(reportAsyncError);
        } else if (ensureProgress) {
          void ensureProgress()
            .then((loaded) => loaded.completeWebviewReady())
            .catch(reportAsyncError);
        }
        return false;
      }
      if (passThroughCommands.has(command)) return false;

      const progress = getProgress();
      if (!progress && ensureProgress) {
        void ensureProgress()
          .then((loaded) => {
            dispatchAndReport(
              message,
              loaded.progressViewInboundHandlers,
              result.data,
            );
          })
          .catch(reportAsyncError);
        return true;
      }
      if (!progress) {
        onUnsupportedCommand(result.data);
        return true;
      }

      dispatchAndReport(
        message,
        progress.progressViewInboundHandlers,
        result.data,
      );
      return true;
    },
  };
}
