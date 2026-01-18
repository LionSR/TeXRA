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
  canUpdateWebview,
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
  { stream, usage, storageKey }: ProgressEventPayloads['updateStreamUsage'],
): void {
  withEventErrorHandling('UsageEvents', 'failed to handle updateStreamUsage', async () => {
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

    if (canUpdateWebview(ctx, stream) && accumulatedUsage) {
      ctx.webviewUpdater.updateRunUsage(stream, storageKey, accumulatedUsage);
    }
  });
}

function handleUpdateContextState(
  ctx: EventHandlerContext,
  { stream, contextState }: ProgressEventPayloads['updateContextState'],
): void {
  withEventErrorHandling('UsageEvents', 'failed to handle updateContextState', () => {
    ctx.state.setContextState(stream, contextState);
    if (canUpdateWebview(ctx, stream)) {
      ctx.webviewUpdater.updateContextState(stream, contextState);
    }
  });
}
