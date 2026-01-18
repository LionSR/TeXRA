/**
 * Follow-up queue event handlers for progress view.
 *
 * Handles the updateQueuedFollowUps event by fetching queue data
 * and sending it to the webview.
 */
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import { withEventErrorHandling } from './errorHandling';
import {
  canUpdateWebview,
  type EventHandlerContext,
} from './EventHandlerContext';

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
  return ({ streamId }: { streamId: StreamTabId }): void => {
    withEventErrorHandling(
      'FollowUpEvents',
      'failed to handle updateQueuedFollowUps',
      () => {
        if (!canUpdateWebview(ctx, streamId)) {
          return;
        }
        const messages = ToolUseFollowUpQueue.getAll(streamId);
        ctx.webviewUpdater.updateQueuedFollowUps(streamId, messages);
      },
    );
  };
}
