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

export function createDesktopErrorReporter(
  onError?: (error: unknown) => void,
): (error: unknown) => void {
  return onError ?? defaultReportError;
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
