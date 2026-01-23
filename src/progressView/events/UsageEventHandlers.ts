/**
 * Usage event handlers for progress view.
 * Handles: updateStreamUsage, updateContextState.
 *
 * These events fire per-round (not per-chunk), so direct sending is fine.
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
  withEventErrorHandling('UsageEvents', 'updateStreamUsage', async () => {
    const accumulated = await ctx.state.usageStats.setRunUsage(
      streamId,
      storageKey,
      usage,
    );

    if (!ctx.state.getActiveRunId(streamId)) {
      ctx.state.setActiveRunId(streamId, storageKey);
    }

    if (accumulated && isWebviewAvailable(ctx)) {
      ctx.webviewUpdater.updateRunUsage(streamId, storageKey, accumulated);
    }
  });
}

function handleUpdateContextState(
  ctx: EventHandlerContext,
  { streamId, contextState }: ProgressEventPayloads['updateContextState'],
): void {
  withEventErrorHandling('UsageEvents', 'updateContextState', () => {
    ctx.state.setContextState(streamId, contextState);
    if (isWebviewAvailable(ctx)) {
      ctx.webviewUpdater.updateContextState(streamId, contextState);
    }
  });
}
