import type { z } from 'zod';

type CommandMessage = { command: string };

type MessageHandler<T> = (data: T) => Promise<void> | void;

/**
 * Marks a command as a deliberate per-host decision rather than an
 * implementation gap. A host with no real handler for a command declares
 * `unsupported(reason)` for it instead of omitting the key, so the fact
 * "this host doesn't do X" lives in exactly one place: the registry itself.
 *
 * {@link HandlerRegistry} requires every command in the shared message union
 * to map to either a real handler or an `Unsupported` marker, so adding a
 * command to the shared schema without deciding it for a given host is a
 * compile error there, not a message that silently no-ops at runtime.
 */
export interface Unsupported {
  readonly unsupported: string;
}

/** Declares a command unsupported on the current host, with a user-facing reason. */
export function unsupported(reason: string): Unsupported {
  return { unsupported: reason };
}

export function isUnsupported(value: unknown): value is Unsupported {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { unsupported?: unknown }).unsupported === 'string'
  );
}

/**
 * Narrows a registry entry to its handler, throwing if it is an
 * {@link Unsupported} marker. For call sites (mainly tests) that invoke a
 * specific registry entry directly instead of going through a dispatcher —
 * production code should prefer the dispatcher, which turns `Unsupported`
 * into visible feedback rather than a thrown error.
 */
export function assertSupported<T>(entry: T | Unsupported): T {
  if (isUnsupported(entry)) {
    throw new Error(
      `Expected a supported handler but this command is unsupported: ${entry.unsupported}`,
    );
  }
  return entry;
}

/**
 * Thrown into a dispatcher's `onError` callback when the matched command
 * resolves to an {@link Unsupported} registry entry. Distinguishes "this host
 * deliberately doesn't do this" from a genuine parse/handler failure so
 * callers can surface it as visible feedback (toast/dialog) instead of an
 * error log.
 */
export class UnsupportedCommandError extends Error {
  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(`Command "${command}" is unsupported on this host: ${reason}`);
    this.name = 'UnsupportedCommandError';
  }
}

/**
 * Every command in `TMessage`'s union maps to either a real handler or an
 * explicit {@link Unsupported} marker. There is no missing/optional case:
 * omitting a command is a compile error, not a silent runtime drop.
 */
export type HandlerRegistry<TMessage extends CommandMessage> = {
  [K in TMessage['command']]:
    MessageHandler<Extract<TMessage, { command: K }>> | Unsupported;
};

export type DispatcherFn<TMessage extends CommandMessage> = (
  raw: unknown,
  handlers: HandlerRegistry<TMessage>,
  onError?: (error: unknown) => void,
) => boolean;

/**
 * Projects a registry to the list of commands it declares `unsupported(...)`.
 * This is how the frontend capability view stays derived from the registry
 * instead of duplicating the same fact in a hand-maintained manifest: a host
 * computes this once (e.g. at webview-ready) from its own registry and sends
 * it down, and the frontend gates controls off the result instead of an
 * `isDesktopHost` check.
 *
 * Takes any `HandlerRegistry<TMessage>` (widened to a plain string-keyed
 * record here — TypeScript can't invert the mapped type to infer `TMessage`
 * from a call site's concrete registry value, and this function only needs
 * to read each entry, not reconstruct its per-command type).
 */
export function unsupportedCommands(
  handlers: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(handlers).filter((command) =>
    isUnsupported(handlers[command]),
  );
}

/**
 * Frontend-side capability check for a command gated by a set the host sent
 * via `unsupportedCommands()` above. `commands` is `null` before the host's
 * one-shot capability broadcast has arrived — treated as "unsupported" (the
 * control stays hidden) rather than "supported" (which would flash a control
 * the active host can't act on before disappearing once the real data
 * lands). Once the broadcast arrives, this reflects the registry exactly.
 */
export function isKnownUnsupported(
  commands: ReadonlySet<string> | null,
  command: string,
): boolean {
  return commands === null || commands.has(command);
}

/**
 * Creates a type-safe message dispatcher for a given schema.
 *
 * @param schema - Zod schema for the message union (must output { command: string, ... })
 * @returns A dispatcher function that parses and routes messages to handlers
 *
 * @example
 * ```typescript
 * // In schema file:
 * export const dispatchMyViewInbound = createDispatcher(MyViewInboundMessageSchema);
 *
 * // Usage:
 * dispatchMyViewInbound(raw, {
 *   'my-command': (msg) => console.log(msg.payload),
 *   'other-command': unsupported('Not available on this host yet.'),
 * });
 * ```
 */
export function createDispatcher<TMessage extends CommandMessage>(
  schema: z.ZodType<TMessage>,
): DispatcherFn<TMessage> {
  return (
    raw: unknown,
    handlers: HandlerRegistry<TMessage>,
    onError?: (error: unknown) => void,
  ): boolean => {
    const parseResult = schema.safeParse(raw);
    if (!parseResult.success) {
      onError?.(parseResult.error);
      return false;
    }

    const message = parseResult.data;
    const entry = handlers[message.command as TMessage['command']] as
      MessageHandler<typeof message> | Unsupported;

    if (isUnsupported(entry)) {
      onError?.(
        new UnsupportedCommandError(message.command, entry.unsupported),
      );
      return false;
    }

    const handlerResult = entry(message);
    if (handlerResult instanceof Promise) {
      handlerResult.catch((error) => onError?.(error));
    }
    return true;
  };
}
