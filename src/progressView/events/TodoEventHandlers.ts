/**
 * Todo event handlers for progress view.
 *
 * Handles todo events: updateTodos.
 */
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import type { TodoItem } from '@eventBus/schemas';
import { withEventErrorHandling } from './errorHandling';
import { canUpdateWebview, type EventHandlerContext } from './EventHandlerContext';

/**
 * Register todo event handlers on the event bus.
 *
 * @param bus - Progress event bus
 * @param ctx - Event handler context with state and webview updater
 * @param signal - AbortController signal for cleanup
 */
export function registerTodoEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('updateTodos', handleUpdateTodos(ctx), { signal });
}

function handleUpdateTodos(ctx: EventHandlerContext) {
  return ({ stream, todos }: { stream: string; todos: TodoItem[] }): void => {
    withEventErrorHandling('TodoEvents', 'failed to handle updateTodos', () => {
      ctx.state.setTodos(stream, todos);
      if (canUpdateWebview(ctx, stream)) {
        ctx.webviewUpdater.updateTodos(stream, todos);
      }
    });
  };
}
