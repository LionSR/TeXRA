// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';
import { serializeError } from '@utils/core';

// Type imports
import type {
  ProgressEvent,
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import type { EventHandlerContext } from './EventHandlerContext';

// Shared logger for all event handlers
const eventLogger = new AgentLogger('ProgressEvents');

/** Serialize an error for logging, preserving original error reference. */
function toErrorData(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { ...serializeError(error), error }
    : { error };
}

/** Check if a value is a thenable (has .catch method). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof (value as PromiseLike<unknown>)?.then === 'function'
  );
}

/** Log an error with module context. */
function logError(moduleName: string, context: string, error: unknown): void {
  eventLogger.error(`[${moduleName}] ${context}`, { data: toErrorData(error) });
}

/**
 * Wraps an event handler with error logging.
 * Handles both sync and async handlers, logging any errors.
 */
export function withEventErrorHandling(
  moduleName: string,
  context: string,
  fn: () => unknown | Promise<unknown>,
): void {
  try {
    const result = fn();
    if (isThenable(result)) {
      void Promise.resolve(result).catch((error) =>
        logError(moduleName, context, error),
      );
    }
  } catch (error) {
    logError(moduleName, context, error);
  }
}

// ============================================================================
// Event Handler Factory
// ============================================================================

/**
 * Handler function type for progress events.
 */
export type EventHandler<E extends ProgressEvent> = (
  ctx: EventHandlerContext,
  payload: ProgressEventPayloads[E],
) => void | Promise<void>;

/**
 * Create an event handler with error handling baked in.
 *
 * Reduces boilerplate by wrapping the handler with withEventErrorHandling
 * and automatically generating the error context message.
 *
 * @example
 * ```ts
 * const handleUpdateTodos = createEventHandler(
 *   'TodoEvents',
 *   'updateTodos',
 *   (ctx, { stream, todos }) => {
 *     ctx.state.setTodos(stream, todos);
 *     if (isWebviewAvailable(ctx)) {
 *       ctx.webviewUpdater.updateTodos(stream, todos);
 *     }
 *   },
 * );
 * ```
 */
export function createEventHandler<E extends ProgressEvent>(
  moduleName: string,
  eventName: E,
  handler: EventHandler<E>,
): EventHandler<E> {
  return (ctx, payload) => {
    withEventErrorHandling(moduleName, `failed to handle ${eventName}`, () =>
      handler(ctx, payload),
    );
  };
}

/**
 * Register multiple event handlers on the event bus.
 *
 * Reduces boilerplate by handling the bus.on() calls and signal passing.
 *
 * @example
 * ```ts
 * registerEventHandlers(bus, ctx, signal, {
 *   updateTodos: handleUpdateTodos,
 *   updateContextState: handleUpdateContextState,
 * });
 * ```
 */
export function registerEventHandlers<E extends ProgressEvent>(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
  handlers: Partial<{ [K in E]: EventHandler<K> }>,
): void {
  for (const [event, handler] of Object.entries(handlers)) {
    if (handler) {
      bus.on(
        event as E,
        (payload) => (handler as EventHandler<E>)(ctx, payload),
        { signal },
      );
    }
  }
}
