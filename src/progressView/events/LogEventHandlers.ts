/**
 * Log event handlers for progress view.
 *
 * Handles log message events: addLogMessage, updateLogMessage.
 */
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import { createEventHandler, registerEventHandlers } from './errorHandling';
import {
  canUpdateWebview,
  isWebviewAvailable,
  type EventHandlerContext,
} from './EventHandlerContext';

const handleAddLogMessage = createEventHandler(
  'LogEvents',
  'addLogMessage',
  async (ctx, { stream, logMessage }) => {
    const isNew = await ctx.state.streamTabs.addMessage(stream, logMessage);
    // Send to webview if available (regardless of active stream - messages persist)
    if (isNew && isWebviewAvailable(ctx)) {
      ctx.webviewUpdater.appendLogMessage(stream, logMessage);
    }
  },
);

const handleUpdateLogMessage = createEventHandler(
  'LogEvents',
  'updateLogMessage',
  (ctx, { stream, logMessage }) => {
    // Skip INTERNAL messages entirely (never shown to users)
    if (logMessage.messageType === MESSAGE_TYPES.INTERNAL) return;

    // Guard: don't create phantom streams for updates to non-existent streams
    if (!ctx.state.streamTabs.has(stream)) return;

    // Find existing message
    const messages = ctx.state.streamTabs.getMessages(stream);
    const existing = messages.find((m) => m.id === logMessage.id);
    if (!existing || existing.messageType === MESSAGE_TYPES.INTERNAL) return;

    // Update state and notify webview
    const { id: _id, ...updates } = logMessage;
    const updated = ctx.state.streamTabs.updateMessage(
      stream,
      logMessage.id,
      updates,
    );

    if (updated && canUpdateWebview(ctx, stream)) {
      ctx.webviewUpdater.updateLogMessage(stream, {
        ...existing,
        ...updates,
      });
    }
  },
);

/**
 * Register log event handlers on the event bus.
 */
export function registerLogEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  registerEventHandlers(bus, ctx, signal, {
    addLogMessage: handleAddLogMessage,
    updateLogMessage: handleUpdateLogMessage,
  });
}
