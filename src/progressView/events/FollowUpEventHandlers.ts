/**
 * Follow-up queue event handlers for progress view.
 *
 * Handles the updateQueuedFollowUps event by fetching queue data
 * and sending it to the webview.
 */
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { withEventErrorHandling } from './errorHandling';
import type { EventHandlerContext } from './EventHandlerContext';

/**
 * Register follow-up queue event handlers on the event bus.
 *
 * @param bus - Progress event bus
 * @param ctx - Event handler context with state and webview updater
 * @param signal - AbortController signal for cleanup
 */
export function registerFollowUpEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('updateQueuedFollowUps', handleUpdateQueuedFollowUps(ctx), { signal });
}

function handleUpdateQueuedFollowUps(ctx: EventHandlerContext) {
  return ({
    streamId,
  }: ProgressEventPayloads['updateQueuedFollowUps']): void => {
    withEventErrorHandling(
      'FollowUpEvents',
      'failed to handle updateQueuedFollowUps',
      () => {
        // Only check webview availability, NOT active stream.
        // Follow-up updates should be sent for any stream (matching old behavior).
        // The frontend handles display logic based on which stream is visible.
        if (ctx.webviewUpdater.isAvailable()) {
          const messages = ToolUseFollowUpQueue.getAll(streamId);
          ctx.webviewUpdater.updateQueuedFollowUps(streamId, messages);
        }
      },
    );
  };
}
