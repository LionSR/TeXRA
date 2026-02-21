/**
 * Follow-up queue event handlers for progress view.
 *
 * Handles the updateQueuedFollowUps event by fetching queue data
 * and sending it to the webview.
 *
 * DESIGN NOTES:
 *
 * 1. Active stream filtering: Only sends to the active stream. Inactive streams
 *    get hydrated via syncStreamContent on tab switch.
 *
 * 2. No state storage: Unlike TodoEventHandlers which stores state via
 *    ctx.state.setTodos(), this handler doesn't store in ProgressViewState.
 *    ToolUseFollowUpQueue is the canonical source of truth for follow-up state.
 *    This avoids duplicating state and keeps queue management centralized.
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
 */
export function registerFollowUpEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on(
    'updateQueuedFollowUps',
    (payload) => handleUpdateQueuedFollowUps(ctx, payload),
    { signal },
  );
}

function handleUpdateQueuedFollowUps(
  ctx: EventHandlerContext,
  { streamId }: ProgressEventPayloads['updateQueuedFollowUps'],
): void {
  withEventErrorHandling(
    'FollowUpEvents',
    'failed to handle updateQueuedFollowUps',
    () => {
      const isActive = streamId === ctx.state.activeStream;
      if (isActive && ctx.webviewUpdater.isAvailable()) {
        const messages = ToolUseFollowUpQueue.getAll(streamId);
        ctx.webviewUpdater.updateQueuedFollowUps(streamId, messages);
      }
    },
  );
}
