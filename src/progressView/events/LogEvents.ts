// Type imports
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  createStatefulEventDisposable,
  type ProgressEventBusLike,
} from './types';
import type { BaseEventShared, StatefulEventModule } from './types';

/**
 * Shared context for LogEvents module.
 * Uses BaseEventShared which provides withErrorBoundary.
 */
type LogEventsShared = BaseEventShared;

/**
 * LogEvents module interface.
 * Uses StatefulEventModule pattern for state/updater access.
 */
export type LogEventsModule = StatefulEventModule;

export function createLogEvents(shared: LogEventsShared): LogEventsModule {
  const { withErrorBoundary } = shared;

  const handleAddLogMessage = (
    data: ProgressEventPayloads['addLogMessage'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    // Note: Debug level and INTERNAL message filtering is done at the source
    // in VSCodeTransport.emitLogEvent() before events reach this handler.
    withErrorBoundary('failed to handle addLogMessage', async () => {
      const { stream, logMessage } = data;

      const isNew = await state.streamTabs.addMessage(stream, logMessage);

      if (isNew && updater.isAvailable()) {
        updater.appendLogMessage(stream, logMessage);
      }
    });
  };

  const handleUpdateLogMessage = (
    data: ProgressEventPayloads['updateLogMessage'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle updateLogMessage', async () => {
      const { stream, logMessage } = data;

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

      if (updater.isAvailable() && stream === state.activeStream) {
        updater.updateLogMessage(stream, existing);
      }
    });
  };

  return {
    register(bus, state, updater) {
      return [
        createStatefulEventDisposable(
          bus,
          'addLogMessage',
          state,
          updater,
          handleAddLogMessage,
        ),
        createStatefulEventDisposable(
          bus,
          'updateLogMessage',
          state,
          updater,
          handleUpdateLogMessage,
        ),
      ];
    },
  };
}
