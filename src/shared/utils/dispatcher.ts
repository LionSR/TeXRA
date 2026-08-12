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

    // Defense-in-depth: TypeScript's exhaustiveness guarantee is a
    // compile-time fact, not a runtime one. A genuinely missing key (an
    // `as`-cast that lies, a dynamically constructed registry, etc.) yields
    // `undefined` here, and `isUnsupported(undefined)` is `false` — so
    // without this guard a missing entry would fall through to
    // `entry(message)` and throw a raw `TypeError` instead of returning the
    // same `false` the old `if (!handler) return false;` fallback gave
    // callers.
    if (!entry) {
      return false;
    }

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

/**
 * Dev/test-only outbound-message assertions. Mirrors `createDispatcher`'s
 * inbound-side validation, but for the send side of the same schemas: a
 * webview/desktop IPC boundary that already has an outbound Zod schema but
 * never runs the payload through it before posting.
 *
 * Both `assertOutboundMessage` and `assertKnownOutboundMessage` are no-ops
 * outside `isDevAssertionMode()` — zero `safeParse` cost in production. Some
 * of these boundaries (desktop's single `postToRenderer` channel carries
 * high-frequency progress-stream chunks, e.g. `LOG_DELTA`) are hot enough
 * that even a cheap parse per message is worth avoiding outside dev/test;
 * production keeps sending the TypeScript-typed payload as-is (a
 * compile-time type-assert, not a runtime check) exactly as it did before
 * this validation existed, so there is no prod behavior or wire-format
 * change. Dev/test throws immediately on a mismatch — schema and producer
 * have drifted — rather than logging, since these are the same runs where
 * `npm test` / CI would otherwise treat drift as silently passing.
 */
function isDevAssertionMode(): boolean {
  return (
    process.env.NODE_ENV === 'test' || process.env.TEXRA_DEV_ASSERTIONS === '1'
  );
}

/**
 * True when a discriminated-union `safeParse` failure means "this message's
 * `command` doesn't belong to this schema at all" (Zod's "no matching
 * discriminator" case) rather than "the command matched but a field is
 * wrong". Only the top-level `command` discriminator counts — a nested
 * discriminated union inside a matched branch (e.g. `UpdatePermissionMessage
 * Schema`'s `action` field) reports its own `invalid_union` issue at a
 * different path, which is a real validation failure, not an unrecognized
 * command.
 */
function isUnrecognizedCommand(error: z.ZodError): boolean {
  const [issue, ...rest] = error.issues;
  return (
    rest.length === 0 &&
    issue?.code === 'invalid_union' &&
    issue.path.length === 1 &&
    issue.path[0] === 'command'
  );
}

/**
 * Asserts (dev/test only) that `message` conforms to `schema` — for a send
 * boundary where every message is known to belong to exactly one outbound
 * domain (e.g. `BaseWebviewManager.postMessage`, which only ever sends
 * `MainViewMessage`s). Throws on any mismatch, including a `command` the
 * schema doesn't recognize at all.
 */
export function assertOutboundMessage<TMessage extends CommandMessage>(
  schema: z.ZodType<TMessage>,
  message: unknown,
): void {
  if (!isDevAssertionMode()) return;
  const result = schema.safeParse(message);
  if (!result.success) {
    throw new Error(
      `Outbound message failed schema validation: ${result.error.message}`,
    );
  }
}

/**
 * Asserts (dev/test only) that `message` conforms to the outbound schema
 * that recognizes its `command` — for a send boundary that multiplexes
 * several outbound domains onto one channel (desktop's single
 * `postToRenderer`, which carries `MainViewMessage`, `ProgressViewOutbound
 * Message`, and desktop-only overlay/settings commands that don't have a
 * schema here yet). `domains` is tried in order; a `command` none of them
 * recognize is out of scope for this call and passes through unchecked —
 * this only guards commands that already have a schema, per the "don't
 * create new schemas" boundary for this change. A `command` a domain does
 * recognize, but whose payload fails that domain's deeper validation, is a
 * real mismatch and throws immediately.
 */
export function assertKnownOutboundMessage(
  domains: readonly z.ZodType<CommandMessage>[],
  message: unknown,
): void {
  if (!isDevAssertionMode()) return;
  for (const schema of domains) {
    const result = schema.safeParse(message);
    if (result.success) return;
    if (!isUnrecognizedCommand(result.error)) {
      throw new Error(
        `Outbound message failed schema validation: ${result.error.message}`,
      );
    }
  }
}
