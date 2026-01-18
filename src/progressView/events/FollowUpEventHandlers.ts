/**
 * Follow-up queue event handlers for progress view.
 *
 * Handles the updateQueuedFollowUps event by fetching queue data
 * and sending it to the webview.
 *
 * DESIGN NOTE: Unlike other handlers (e.g., TodoEventHandlers), this does NOT
 * filter by active stream. Follow-up updates are sent for any stream because:
 * 1. Follow-ups represent user messages waiting to be processed - losing them is worse
 *    than showing updates for a non-visible stream
 * 2. refreshStreamSurface doesn't refresh queued follow-ups when switching streams
 *    (unlike todos, files, and usage which get refreshed)
 * 3. The frontend handles display logic based on which stream is visible
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
        // Don't filter by active stream - see module docstring for rationale
        if (ctx.webviewUpdater.isAvailable()) {
          const messages = ToolUseFollowUpQueue.getAll(streamId);
          ctx.webviewUpdater.updateQueuedFollowUps(streamId, messages);
        }
      },
    );
  };
}
