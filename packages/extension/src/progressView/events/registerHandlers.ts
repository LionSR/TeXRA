/**
 * Declarative event registration helper for ProgressEventBus.
 */

import type {
  ProgressEventBusLike,
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

import { withEventErrorHandling } from './errorHandling';
import type { EventHandlerContext } from './EventHandlerContext';

/**
 * Context-injected handler: receives EventHandlerContext as first argument,
 * wrapped with withEventErrorHandling automatically.
 */
type ContextHandlerMap = {
  [K in ProgressEvent]?: (
    ctx: EventHandlerContext,
    payload: ProgressEventPayloads[K],
  ) => void | Promise<void>;
};

/**
 * Register multiple context-aware event handlers with automatic error handling.
 * Each handler receives the EventHandlerContext and is wrapped with
 * withEventErrorHandling for consistent error logging.
 */
export function registerHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  handlers: ContextHandlerMap,
  signal: AbortSignal,
  defaultModule: string,
): void {
  for (const [event, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    bus.on(
      event as ProgressEvent,
      (payload: any) =>
        withEventErrorHandling(defaultModule, `failed to handle ${event}`, () =>
          (handler as any)(ctx, payload),
        ),
      { signal },
    );
  }
}
