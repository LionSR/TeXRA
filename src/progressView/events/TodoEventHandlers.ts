/**
 * Todo event handlers for progress view.
 *
 * Handles todo events: updateTodos.
 */
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import { createEventHandler, registerEventHandlers } from './errorHandling';
import {
  isWebviewAvailable,
  type EventHandlerContext,
} from './EventHandlerContext';

const handleUpdateTodos = createEventHandler(
  'TodoEvents',
  'updateTodos',
  (ctx, { stream, todos }) => {
    ctx.state.setTodos(stream, todos);
    // Broadcast to webview - frontend decides which run to display
    if (isWebviewAvailable(ctx)) {
      ctx.webviewUpdater.updateTodos(stream, todos);
    }
  },
);

/**
 * Register todo event handlers on the event bus.
 */
export function registerTodoEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  registerEventHandlers(bus, ctx, signal, {
    updateTodos: handleUpdateTodos,
  });
}
