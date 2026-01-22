/**
 * Usage event handlers for progress view.
 *
 * Handles usage events: updateStreamUsage, updateContextState.
 */
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { withEventErrorHandling } from './errorHandling';
import {
  isWebviewAvailable,
  type EventHandlerContext,
} from './EventHandlerContext';

/**
 * Register usage event handlers on the event bus.
 */
export function registerUsageEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on(
    'updateStreamUsage',
    (payload) => handleUpdateStreamUsage(ctx, payload),
    { signal },
  );
  bus.on(
    'updateContextState',
    (payload) => handleUpdateContextState(ctx, payload),
    { signal },
  );
}

function handleUpdateStreamUsage(
  ctx: EventHandlerContext,
  { streamId, usage, storageKey }: ProgressEventPayloads['updateStreamUsage'],
): void {
  withEventErrorHandling(
    'UsageEvents',
    'failed to handle updateStreamUsage',
    async () => {
      // usage is already typed as TokenUsageStats from the event payload
      const accumulatedUsage = await ctx.state.usageStats.setRunUsage(
        streamId,
        storageKey,
        usage,
      );

      // For tool-use sessions (no task groups), set active run ID from usage
      if (!ctx.state.getActiveRunId(streamId)) {
        ctx.state.setActiveRunId(streamId, storageKey);
      }

      // Broadcast to webview - frontend decides which run to display
      if (isWebviewAvailable(ctx) && accumulatedUsage) {
        ctx.webviewUpdater.updateRunUsage(streamId, storageKey, accumulatedUsage);
      }
    },
  );
}

function handleUpdateContextState(
  ctx: EventHandlerContext,
  { streamId, contextState }: ProgressEventPayloads['updateContextState'],
): void {
  withEventErrorHandling(
    'UsageEvents',
    'failed to handle updateContextState',
    () => {
      ctx.state.setContextState(streamId, contextState);
      // Broadcast to webview - frontend decides which run to display
      if (isWebviewAvailable(ctx)) {
        ctx.webviewUpdater.updateContextState(streamId, contextState);
      }
    },
  );
}
