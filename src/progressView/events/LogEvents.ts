// Type imports
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import {
  sendIfActive,
  type ProgressEventBusLike,
  type Unsubscribe,
} from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'LogEvents';

/**
 * Register log event handlers.
 * Returns unsubscribe functions - caller handles VSCode Disposable wrapping.
 */
export function registerLogEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
): Unsubscribe[] {
  return [
    // Note: Debug level and INTERNAL message filtering is done at the source
    // in VSCodeTransport.emitLogEvent() before events reach this handler.
    bus.on('addLogMessage', ({ stream, logMessage }) => {
      withEventErrorHandling(
        MODULE,
        'failed to handle addLogMessage',
        async () => {
          const isNew = await state.streamTabs.addMessage(stream, logMessage);

          if (isNew && updater.isAvailable()) {
            updater.appendLogMessage(stream, logMessage);
          }
        },
      );
    }),
    bus.on('updateLogMessage', ({ stream, logMessage }) => {
      withEventErrorHandling(
        MODULE,
        'failed to handle updateLogMessage',
        async () => {
          if (!state.streamTabs.has(stream)) {
            return;
          }

          const messages = state.streamTabs.getMessages(stream);
          const existing = messages.find((m) => m.id === logMessage.id);
          if (!existing) return;

          if (
            existing.messageType === MESSAGE_TYPES.INTERNAL ||
            logMessage.messageType === MESSAGE_TYPES.INTERNAL
          ) {
            return;
          }

          // Update fields if provided
          if (logMessage.text !== undefined) existing.text = logMessage.text;
          if (logMessage.messageType !== undefined)
            existing.messageType = logMessage.messageType;
          if (logMessage.level) existing.level = logMessage.level;
          if (logMessage.timestamp !== undefined)
            existing.timestamp = logMessage.timestamp;
          if (logMessage.verbose !== undefined)
            existing.verbose = logMessage.verbose;
          if (logMessage.data !== undefined) existing.data = logMessage.data;

          await state.streamTabs.save();

          sendIfActive(stream, state, updater, () => {
            updater.updateLogMessage(stream, existing);
          });
        },
      );
    }),
  ];
}
