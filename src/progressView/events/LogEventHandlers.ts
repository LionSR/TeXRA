/**
 * Log event handlers for progress view.
 *
 * Handles log message events: addLogMessage, updateLogMessage.
 */
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type {
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { withEventErrorHandling } from './errorHandling';
import {
  canUpdateWebview,
  isWebviewAvailable,
  type EventHandlerContext,
} from './EventHandlerContext';

/**
 * Register log event handlers on the event bus.
 */
export function registerLogEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on(
    'addLogMessage',
    (payload) => handleAddLogMessage(ctx, payload),
    { signal },
  );
  bus.on(
    'updateLogMessage',
    (payload) => handleUpdateLogMessage(ctx, payload),
    { signal },
  );
}

function handleAddLogMessage(
  ctx: EventHandlerContext,
  { stream, logMessage }: ProgressEventPayloads['addLogMessage'],
): void {
  withEventErrorHandling('LogEvents', 'failed to handle addLogMessage', async () => {
    const isNew = await ctx.state.streamTabs.addMessage(stream, logMessage);
    // Send to webview if available (regardless of active stream - messages persist)
    if (isNew && isWebviewAvailable(ctx)) {
      ctx.webviewUpdater.appendLogMessage(stream, logMessage);
    }
  });
}

function handleUpdateLogMessage(
  ctx: EventHandlerContext,
  { stream, logMessage }: ProgressEventPayloads['updateLogMessage'],
): void {
  withEventErrorHandling('LogEvents', 'failed to handle updateLogMessage', () => {
    if (!ctx.state.streamTabs.has(stream)) return;

    // Check if message exists and get its type for INTERNAL filtering
    const messages = ctx.state.streamTabs.getMessages(stream);
    const existing = messages.find((m) => m.id === logMessage.id);
    if (!existing) return;

    // Skip INTERNAL message updates (either existing or incoming)
    if (
      existing.messageType === MESSAGE_TYPES.INTERNAL ||
      logMessage.messageType === MESSAGE_TYPES.INTERNAL
    ) {
      return;
    }

    // Update via proper encapsulated method (no direct mutation)
    const { id: _id, ...updates } = logMessage;
    const updated = ctx.state.streamTabs.updateMessage(stream, logMessage.id, updates);

    if (updated && canUpdateWebview(ctx, stream)) {
      // Send merged update to webview
      ctx.webviewUpdater.updateLogMessage(stream, { ...existing, ...updates });
    }
  });
}
