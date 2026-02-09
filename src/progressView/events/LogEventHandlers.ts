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
  withEventErrorHandling('LogEvents', 'failed to handle addLogMessage', () => {
    const isNew = ctx.state.streamTabs.addMessage(streamId, logMessage);
    // Only send to webview for the active stream. Inactive streams get
    // their full log history via UPDATE_LOGS on tab switch, so sending
    // APPEND_LOG for them is wasted work (serialization + frontend state churn).
    const isActive = streamId === ctx.state.activeStream;
    if (isNew && isActive && ctx.webviewUpdater.isAvailable()) {
      ctx.webviewUpdater.appendLogMessage(streamId, logMessage);
    }
  });
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

      // Find and guard before mutating stored messages.
      const { id: _id, ...updates } = logMessage;
      const existingMessage = ctx.state.streamTabs.findMessage(
        streamId,
        logMessage.id,
      );
      if (!existingMessage) return;
      if (existingMessage.messageType === MESSAGE_TYPES.INTERNAL) return;

      const existing = ctx.state.streamTabs.updateMessage(
        streamId,
        logMessage.id,
        updates,
      );
      if (!existing) return;

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
