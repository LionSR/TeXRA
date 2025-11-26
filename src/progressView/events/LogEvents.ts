// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { LogMessageUpdate } from '@logger/LogTypes';
// Type imports
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local imports - events
import { getConfig } from '@utils/config';

// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import { createErrorBoundary } from './errorHandling';

// Type imports
import type { ProgressEventBusLike } from './types';

interface LogEventsShared {
  logger: AgentLogger;
}

export interface LogEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

export function createLogEvents(shared: LogEventsShared): LogEventsModule {
  const withErrorBoundary = createErrorBoundary(shared.logger, 'LogEvents');

  const handleAddLogMessage = (
    data: ProgressEventPayloads['addLogMessage'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle addLogMessage', async () => {
      const { stream, logMessage } = data;

      if (
        logMessage.level === 'debug' &&
        !getConfig<boolean>('texra.logger.debugMode', false)
      ) {
        return;
      }

      if (logMessage.messageType === MESSAGE_TYPES.INTERNAL) {
        return;
      }

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

      if (logMessage.text !== undefined) {
        existing.text = logMessage.text;
      }
      if (logMessage.messageType !== undefined) {
        existing.messageType = logMessage.messageType;
      }
      if (logMessage.level) {
        existing.level = logMessage.level;
      }
      if (logMessage.timestamp !== undefined) {
        existing.timestamp = logMessage.timestamp;
      }
      if (logMessage.verbose !== undefined) {
        existing.verbose = logMessage.verbose;
      }
      if (logMessage.data !== undefined) {
        existing.data = logMessage.data;
      }

      await state.streamTabs.save();

      if (updater.isAvailable() && stream === state.activeStream) {
        updater.updateLogMessage(stream, existing);
      }
    });
  };

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      return [
        new vscode.Disposable(
          bus.on('addLogMessage', (payload) =>
            handleAddLogMessage(payload, state, updater),
          ),
        ),
        new vscode.Disposable(
          bus.on('updateLogMessage', (payload) =>
            handleUpdateLogMessage(payload, state, updater),
          ),
        ),
      ];
    },
  };
}
