import { MESSAGE_TYPES } from '@shared/schemas';
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

import { withEventErrorHandling } from './errorHandling';
import type { EventHandlerContext } from './EventHandlerContext';

export function registerLogEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('addLogMessage', (payload) => handleAddLogMessage(ctx, payload), {
    signal,
  });
  bus.on(
    'updateLogMessage',
    (payload) => handleUpdateLogMessage(ctx, payload),
    { signal },
  );
}

function handleAddLogMessage(
  ctx: EventHandlerContext,
  { streamId, logMessage }: ProgressEventPayloads['addLogMessage'],
): void {
  withEventErrorHandling(
    'LogEvents',
    'failed to handle addLogMessage',
    async () => {
      const isNew = await ctx.state.streamTabs.addMessage(streamId, logMessage);
      // Send to webview if available (regardless of active stream - messages persist)
      if (isNew && ctx.webviewUpdater.isAvailable()) {
        ctx.webviewUpdater.appendLogMessage(streamId, logMessage);
      }
    },
  );
}

function handleUpdateLogMessage(
  ctx: EventHandlerContext,
  { streamId, logMessage }: ProgressEventPayloads['updateLogMessage'],
): void {
  withEventErrorHandling(
    'LogEvents',
    'failed to handle updateLogMessage',
    () => {
      // Skip INTERNAL messages entirely (never shown to users)
      if (logMessage.messageType === MESSAGE_TYPES.INTERNAL) return;

      // Guard: don't create phantom streams for updates to non-existent streams
      if (!ctx.state.streamTabs.has(streamId)) return;

      // Single-pass: find, guard, and update in one scan
      const { id: _id, ...updates } = logMessage;
      const existing = ctx.state.streamTabs.updateMessage(
        streamId,
        logMessage.id,
        updates,
      );
      if (!existing || existing.messageType === MESSAGE_TYPES.INTERNAL) return;

      const isActive = streamId === ctx.state.activeStream;
      if (ctx.webviewUpdater.isAvailable() && isActive) {
        ctx.webviewUpdater.updateLogMessage(streamId, {
          ...existing,
          ...updates,
        });
      }
    },
  );
}
