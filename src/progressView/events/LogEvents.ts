// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

// Local imports - logger
import type { LogMessageUpdate } from '@logger/LogTypes';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getConfig } from '@utils/config';

import type { AgentLogger } from '@logger/AgentLogger';

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
    withErrorBoundary('failed to handle addLogMessage', () => {
      const { stream, logMessage } = data;

      if (
        logMessage.level === 'debug' &&
        !getConfig<boolean>('logger.debugMode', false)
      ) {
        return;
      }

      if (logMessage.messageType === MESSAGE_TYPES.INTERNAL) {
        return;
      }

      state.streamTabs.addMessage(stream, logMessage);

      if (updater.isAvailable()) {
        updater.appendLogMessage(stream, logMessage);
      }
    });
  };

  const handleUpdateLogMessage = (
    data: ProgressEventPayloads['updateLogMessage'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle updateLogMessage', () => {
      const { stream, logMessage } = data;

      const messages = state.streamTabs.get(stream);
      if (!messages) return;

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

      state.streamTabs.save();

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
