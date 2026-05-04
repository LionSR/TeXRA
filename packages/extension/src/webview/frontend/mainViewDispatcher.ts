/**
 * Schema-driven message dispatcher for MainView.
 *
 * Uses Zod's discriminated union to parse messages once, then dispatches
 * to type-safe handlers. Eliminates boilerplate type casts in handlers.
 */

import { mainViewMessages, type MainViewMessage } from '@shared/schemas';

// ============================================================
// Type-safe handler registry types
// ============================================================

/**
 * Handler function type - receives typed message data (already validated).
 */
type TypedHandler<T extends MainViewMessage> = (data: T) => void;

/**
 * Handler registry mapping command to typed handler.
 * TypeScript ensures handlers receive the correct message type.
 */
export type MainViewHandlerRegistry = {
  [K in MainViewMessage['command']]?: TypedHandler<
    Extract<MainViewMessage, { command: K }>
  >;
};

/**
 * Dispatch a message to its handler using schema-driven validation.
 *
 * @param raw - Raw message from VS Code postMessage
 * @param handlers - Typed handler registry
 * @param onError - Optional error callback for validation failures
 * @returns true if message was handled, false otherwise
 */
export function dispatchMainViewMessage(
  raw: unknown,
  handlers: MainViewHandlerRegistry,
  onError?: (error: unknown) => void,
): boolean {
  const result = mainViewMessages.MainViewMessageSchema.safeParse(raw);
  if (!result.success) {
    onError?.(result.error);
    return false;
  }

  const message = result.data;
  const handler = handlers[message.command] as
    | TypedHandler<typeof message>
    | undefined;

  if (handler) {
    handler(message);
    return true;
  }

  return false;
}
