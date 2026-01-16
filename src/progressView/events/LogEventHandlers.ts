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
  type EventHandlerContext,
} from './EventHandlerContext';

/**
 * Register log event handlers on the event bus.
 *
 * @param bus - Progress event bus
 * @param ctx - Event handler context with state and webview updater
 * @param signal - AbortController signal for cleanup
 */
export function registerLogEventHandlers(
  bus: ProgressEventBusLike,
  ctx: EventHandlerContext,
  signal: AbortSignal,
): void {
  bus.on('addLogMessage', handleAddLogMessage(ctx), { signal });
  bus.on('updateLogMessage', handleUpdateLogMessage(ctx), { signal });
}

function handleAddLogMessage(ctx: EventHandlerContext) {
  return ({
    stream,
    logMessage,
  }: ProgressEventPayloads['addLogMessage']): void => {
    withEventErrorHandling(
      'LogEvents',
      'failed to handle addLogMessage',
      async () => {
        const isNew = await ctx.state.streamTabs.addMessage(stream, logMessage);
        if (isNew && ctx.webviewUpdater.isAvailable()) {
          ctx.webviewUpdater.appendLogMessage(stream, logMessage);
        }
      },
    );
  };
}

function handleUpdateLogMessage(ctx: EventHandlerContext) {
  return ({
    stream,
    logMessage,
  }: ProgressEventPayloads['updateLogMessage']): void => {
    withEventErrorHandling(
      'LogEvents',
      'failed to handle updateLogMessage',
      async () => {
        if (!ctx.state.streamTabs.has(stream)) return;

        const messages = ctx.state.streamTabs.getMessages(stream);
        const existing = messages.find((m) => m.id === logMessage.id);
        if (!existing) return;

        // Skip INTERNAL message updates
        if (
          existing.messageType === MESSAGE_TYPES.INTERNAL ||
          logMessage.messageType === MESSAGE_TYPES.INTERNAL
        ) {
          return;
        }

        // Update fields from logMessage, preserving existing values for undefined fields
        const { id: _id, ...updates } = logMessage;
        Object.assign(existing, updates);

        await ctx.state.streamTabs.save();

        if (canUpdateWebview(ctx, stream)) {
          ctx.webviewUpdater.updateLogMessage(stream, existing);
        }
      },
    );
  };
}
