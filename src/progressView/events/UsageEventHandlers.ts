/**
 * Usage event handlers for progress view.
 *
 * Handles usage events: updateStreamUsage, updateContextState.
 */
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import { createEventHandler, registerEventHandlers } from './errorHandling';
import {
  isWebviewAvailable,
  type EventHandlerContext,
} from './EventHandlerContext';

const handleUpdateStreamUsage = createEventHandler(
  'UsageEvents',
  'updateStreamUsage',
  async (ctx, { stream, usage, storageKey }) => {
    // usage is already typed as TokenUsageStats from the event payload
    const accumulatedUsage = await ctx.state.usageStats.setRunUsage(
      stream,
      storageKey,
      usage,
    );

    // For tool-use sessions (no task groups), set active run ID from usage
    if (!ctx.state.getActiveRunId(stream)) {
      ctx.state.setActiveRunId(stream, storageKey);
    }

    // Broadcast to webview - frontend decides which run to display
    if (isWebviewAvailable(ctx) && accumulatedUsage) {
      ctx.webviewUpdater.updateRunUsage(stream, storageKey, accumulatedUsage);
    }
  },
);

const handleUpdateContextState = createEventHandler(
  'UsageEvents',
  'updateContextState',
  (ctx, { stream, contextState }) => {
    ctx.state.setContextState(stream, contextState);
    // Broadcast to webview - frontend decides which run to display
    if (isWebviewAvailable(ctx)) {
      ctx.webviewUpdater.updateContextState(stream, contextState);
    }
  },
);

/**
 * Register usage event handlers on the event bus.
 */
export function registerUsageEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  registerEventHandlers(bus, ctx, signal, {
    updateStreamUsage: handleUpdateStreamUsage,
    updateContextState: handleUpdateContextState,
  });
}
