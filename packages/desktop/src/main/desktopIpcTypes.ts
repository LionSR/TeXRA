import { MainViewMessageSchema } from '@shared/schemas/mainView';
import { ProgressViewOutboundMessageSchema } from '@shared/schemas/progressView';
import {
  assertKnownOutboundMessage,
  UnsupportedCommandError,
} from '@shared/utils/dispatcher';

export type DesktopCommandMessage = { command: string } & Record<
  string,
  unknown
>;

export interface DesktopMessageHandler {
  handleMessage(message: DesktopCommandMessage): boolean;
}

export interface DesktopRenderer {
  postToRenderer(message: unknown): void;
}

/**
 * Dev/test-only shape check for every message posted to the desktop
 * renderer through {@link DesktopRenderer.postToRenderer}. Desktop
 * multiplexes `MainViewMessage`s, `ProgressViewOutboundMessage`s, and
 * desktop-only overlay/settings commands (`desktop:showPdf`, git-author
 * settings, history, ...) onto the one renderer-push channel
 * (`installDesktopHostBridge` in `hostBridge.ts`, the sole caller of this
 * function); only the first two domains have an outbound Zod schema today —
 * a command belonging to neither passes through unchecked, per
 * `assertKnownOutboundMessage`. No-op outside dev/test: this channel also
 * carries high-frequency progress-stream chunks, so production keeps
 * sending the typed payload as-is with zero added parse cost (see
 * `assertKnownOutboundMessage` for the full rationale).
 */
export function assertDesktopOutboundMessage(message: unknown): void {
  assertKnownOutboundMessage(
    [MainViewMessageSchema, ProgressViewOutboundMessageSchema],
    message,
  );
}

export function isDesktopCommandMessage(
  message: unknown,
): message is DesktopCommandMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'command' in message &&
    typeof message.command === 'string'
  );
}

/**
 * Wraps a dispatcher's `onError` callback so an {@link UnsupportedCommandError}
 * (a registry entry declared `unsupported(...)`) is routed to `onUnsupported`
 * — the host's visible-feedback surface (e.g. a native info dialog) — instead
 * of the generic error reporter. Every desktop dispatcher call site shares
 * this so "command deliberately unsupported here" always produces visible
 * feedback rather than a console-only log.
 */
export function createDesktopErrorReporter(
  onError?: (error: unknown) => void,
  onUnsupported?: (error: UnsupportedCommandError) => void,
): (error: unknown) => void {
  const reportError = onError ?? defaultReportError;
  if (!onUnsupported) return reportError;
  return (error: unknown) => {
    if (error instanceof UnsupportedCommandError) {
      onUnsupported(error);
      return;
    }
    reportError(error);
  };
}

function defaultReportError(error: unknown): void {
  console.error(error);
}

type CommandRunner = (message: DesktopCommandMessage) => void | Promise<void>;

export interface CommandHandlerEntry {
  /** The work to perform when the command matches. */
  run: CommandRunner;
  /**
   * Optional guard. When it returns `false` the entry is treated as not
   * matching, so `handleMessage` returns `false` and sibling handlers still
   * receive the message.
   */
  when?: (message: DesktopCommandMessage) => boolean;
  /**
   * Whether claiming the command stops the dispatch chain. Defaults to
   * `true`. Set to `false` for broadcast commands (e.g. `WEBVIEW_READY`) that
   * should still reach sibling handlers after running.
   */
  claim?: boolean;
}

export type CommandHandlerMap = Record<
  string,
  CommandRunner | CommandHandlerEntry
>;

export interface CreateCommandHandlerOptions {
  onAsyncError?: (error: unknown) => void;
}

/**
 * Builds a {@link DesktopMessageHandler} from a `command → handler` map,
 * centralizing the type-dispatch, async-error wrapping, and claim semantics
 * that every manual `switch (message.command)` handler used to repeat.
 *
 * A bare function entry claims the command (returns `true`). Use the object
 * form to add a `when` guard or to broadcast (`claim: false`).
 */
export function createCommandHandler(
  handlers: CommandHandlerMap,
  options: CreateCommandHandlerOptions = {},
): DesktopMessageHandler {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const entry = handlers[message.command];
      if (entry == null) return false;

      const { run, when, claim } =
        typeof entry === 'function' ? { run: entry } : entry;
      if (when != null && !when(message)) return false;

      const result = run(message);
      if (result instanceof Promise) result.catch(reportAsyncError);
      return claim ?? true;
    },
  };
}
