/**
 * Usage event handlers for progress view.
 *
 * Handles usage events: updateStreamUsage, updateContextState.
 */
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { withEventErrorHandling } from './errorHandling';
import { canUpdateWebview, type EventHandlerContext } from './EventHandlerContext';

/**
 * Register usage event handlers on the event bus.
 *
 * @param bus - Progress event bus
 * @param ctx - Event handler context with state and webview updater
 * @param signal - AbortController signal for cleanup
 */
export function registerUsageEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('updateStreamUsage', handleUpdateStreamUsage(ctx), { signal });
  bus.on('updateContextState', handleUpdateContextState(ctx), { signal });
}

function handleUpdateStreamUsage(ctx: EventHandlerContext) {
  return ({
    stream,
    usage,
    storageKey,
  }: ProgressEventPayloads['updateStreamUsage']): void => {
    withEventErrorHandling(
      'UsageEvents',
      'failed to handle updateStreamUsage',
      async () => {
        const normalizedUsage: TokenUsageStats = {
          inputTokens: Number(usage.inputTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          cost: Number(usage.cost ?? 0),
          // Cache tokens for display (use ?? for nullish-only coalescing)
          cacheReadInputTokens: Number(usage.cacheReadInputTokens ?? 0),
          cacheCreationInputTokens: Number(usage.cacheCreationInputTokens ?? 0),
        };

        // Backend accumulates the delta and returns the accumulated value
        // This avoids race conditions from a separate read operation
        const accumulatedUsage = await ctx.state.usageStats.setRunUsage(
          stream,
          storageKey,
          normalizedUsage,
        );

        // For tool-use sessions (no task groups), set active run ID from usage
        // so the frontend can resolve which run's usage to display.
        // For workflow sessions, task group creation already set this.
        if (!ctx.state.getActiveRunId(stream)) {
          ctx.state.setActiveRunId(stream, storageKey);
        }

        if (canUpdateWebview(ctx, stream) && accumulatedUsage) {
          // Send accumulated value to frontend (not the delta)
          // Frontend uses SET semantics to avoid double-counting
          ctx.webviewUpdater.updateRunUsage(
            stream,
            storageKey,
            accumulatedUsage,
          );
        }
      },
    );
  };
}

function handleUpdateContextState(ctx: EventHandlerContext) {
  return ({
    stream,
    contextState,
  }: ProgressEventPayloads['updateContextState']): void => {
    withEventErrorHandling(
      'UsageEvents',
      'failed to handle updateContextState',
      () => {
        // Store context state for replay when switching streams
        ctx.state.setContextState(stream, contextState);
        if (canUpdateWebview(ctx, stream)) {
          ctx.webviewUpdater.updateContextState(stream, contextState);
        }
      },
    );
  };
}
