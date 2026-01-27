/**
 * Generic message dispatcher factory for type-safe message handling.
 *
 * Eliminates duplicate dispatch functions across view message schemas.
 * Each view uses createDispatcher() with its message schema to get a
 * type-safe dispatcher function.
 */

import type { z } from 'zod';

/**
 * Constraint for message types with a command discriminant.
 */
type CommandMessage = { command: string };

/**
 * Handler function type for a specific message.
 */
type MessageHandler<T> = (data: T) => Promise<void> | void;

/**
 * Handler registry mapping command names to typed handlers.
 * Handlers are optional - missing handlers are silently skipped.
 */
export type HandlerRegistry<TMessage extends CommandMessage> = {
  [K in TMessage['command']]?: MessageHandler<
    Extract<TMessage, { command: K }>
  >;
};

/**
 * Dispatcher function signature.
 */
export type DispatcherFn<TMessage extends CommandMessage> = (
  raw: unknown,
  handlers: HandlerRegistry<TMessage>,
  onError?: (error: unknown) => void,
) => boolean;

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
    const result = schema.safeParse(raw);
    if (!result.success) {
      onError?.(result.error);
      return false;
    }

    const message = result.data;
    const handler = handlers[message.command as TMessage['command']] as
      | MessageHandler<typeof message>
      | undefined;

    if (handler) {
      const maybePromise = handler(message);
      if (maybePromise instanceof Promise) {
        maybePromise.catch((error) => onError?.(error));
      }
      return true;
    }

    return false;
  };
}
