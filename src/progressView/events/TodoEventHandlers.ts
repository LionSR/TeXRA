/**
 * Todo event handlers for progress view.
 *
 * Handles todo events: updateTodos.
 */
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { withEventErrorHandling } from './errorHandling';
import type { EventHandlerContext } from './EventHandlerContext';

/**
 * Register todo event handlers on the event bus.
 */
export function registerTodoEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('updateTodos', (payload) => handleUpdateTodos(ctx, payload), {
    signal,
  });
}

function handleUpdateTodos(
  ctx: EventHandlerContext,
  { streamId, todos }: ProgressEventPayloads['updateTodos'],
): void {
  withEventErrorHandling('TodoEvents', 'failed to handle updateTodos', () => {
    ctx.state.setTodos(streamId, todos);
    // Broadcast to webview - frontend decides which run to display
    if (ctx.webviewUpdater.isAvailable()) {
      ctx.webviewUpdater.updateTodos(streamId, todos);
    }
  });
}
