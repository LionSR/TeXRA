import type { z } from 'zod';

type CommandMessage = { command: string };

type MessageHandler<T> = (data: T) => Promise<void> | void;

export type HandlerRegistry<TMessage extends CommandMessage> = {
  [K in TMessage['command']]?: MessageHandler<
    Extract<TMessage, { command: K }>
  >;
};

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
    const parseResult = schema.safeParse(raw);
    if (!parseResult.success) {
      onError?.(parseResult.error);
      return false;
    }

    const message = parseResult.data;
    const handler = handlers[message.command as TMessage['command']] as
      | MessageHandler<typeof message>
      | undefined;

    if (!handler) {
      return false;
    }

    const handlerResult = handler(message);
    if (handlerResult instanceof Promise) {
      handlerResult.catch((error) => onError?.(error));
    }
    return true;
  };
}
