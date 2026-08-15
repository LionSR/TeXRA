import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchProgressViewInbound,
  ProgressViewInboundMessageSchema,
  type ProgressViewInboundHandlerRegistry,
  type ProgressViewInboundMessage,
} from '@shared/schemas';
import { UnsupportedCommandError } from '@shared/utils/dispatcher';

import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';

const PASS_THROUGH_COMMANDS = [PROGRESS_VIEW_COMMANDS.SWITCH_VIEW] as const;

type DesktopProgressIpcOwnedCommand =
  | typeof PROGRESS_VIEW_COMMANDS.WEBVIEW_READY
  | (typeof PASS_THROUGH_COMMANDS)[number];

export type DesktopProgressInboundHandlerRegistry = Omit<
  ProgressViewInboundHandlerRegistry,
  DesktopProgressIpcOwnedCommand
>;

interface DesktopProgressIpcBridge {
  readonly progressViewInboundHandlers: DesktopProgressInboundHandlerRegistry;
  completeWebviewReady(): Promise<void>;
}

interface DesktopProgressSource {
  get(): DesktopProgressIpcBridge | undefined;
  ensure(): Promise<DesktopProgressIpcBridge>;
}

export interface DesktopProgressIpcOptions {
  source: DesktopProgressSource;
  /** Called for a recognized command that wasn't dispatched to a real
   *  handler. A matched `unsupported(...)` registry entry supplies its
   *  message as `reason`. A schema-invalid message never reaches this
   *  callback; `handleMessage` returns `false` for it instead. */
  onUnsupportedCommand?: (
    message: ProgressViewInboundMessage,
    reason?: string,
  ) => void;
  onAsyncError?: (error: unknown) => void;
}

export type DesktopProgressIpc = DesktopMessageHandler;

const passThroughCommands: ReadonlySet<string> = new Set(PASS_THROUGH_COMMANDS);

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

  function withProgress(run: (progress: DesktopProgressIpcBridge) => void) {
    const progress = options.source.get();
    if (progress) {
      run(progress);
      return;
    }
    void options.source.ensure().then(run).catch(reportAsyncError);
  }

  // Splits a dispatch's onError callback: an UnsupportedCommandError (a
  // registry entry declared `unsupported(...)`) is captured for
  // onUnsupportedCommand's visible feedback below instead of being logged
  // as a generic error.
  function dispatchAndReport(
    message: DesktopCommandMessage,
    handlers: DesktopProgressInboundHandlerRegistry,
    parsed: ProgressViewInboundMessage,
  ): boolean {
    let unsupportedReason: string | undefined;
    // handleMessage returns before this point for every omitted command. The
    // shared dispatcher cannot express that runtime narrowing because it
    // parses the raw message itself, so keep the assertion at this boundary.
    const handled = dispatchProgressViewInbound(
      message,
      handlers as ProgressViewInboundHandlerRegistry,
      (error) => {
        if (error instanceof UnsupportedCommandError) {
          unsupportedReason = error.reason;
          return;
        }
        reportAsyncError(error);
      },
    );
    if (!handled) onUnsupportedCommand(parsed, unsupportedReason);
    return handled;
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const result = ProgressViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      // WEBVIEW_READY and pass-through commands return false so sibling
      // handlers in the chain still receive them.
      if (result.data.command === PROGRESS_VIEW_COMMANDS.WEBVIEW_READY) {
        if (result.data.view !== 'progress') return false;
        withProgress((progress) => {
          void progress.completeWebviewReady().catch(reportAsyncError);
        });
        return false;
      }
      const command = result.data.command;
      if (passThroughCommands.has(command)) return false;

      withProgress((progress) => {
        dispatchAndReport(
          message,
          progress.progressViewInboundHandlers,
          result.data,
        );
      });
      return true;
    },
  };
}
