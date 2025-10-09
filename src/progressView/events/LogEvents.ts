// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// @ts-ignore - Import JavaScript module
import { STATUS } from '../modules/constants.js';

// Local imports - agent
import { AgentSessionKind } from '@agent/core/AgentDataclass';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - events
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

// Local imports - logger
import { parseLegacyLogData } from '@logger/logUtils';
import type {
  LogMessageData,
  LogMessageUpdate,
  TaskGroup,
} from '@logger/LogTypes';
import { getConfig } from '@utils/config';

import type {
  StreamStatusOrReadyType,
  StreamStatusType,
} from './ProgressEventHandler';
import type { AgentLogger } from '@logger/AgentLogger';

interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void;
}

interface LogEventsShared {
  logger: AgentLogger;
  streamStatus: Map<string, StreamStatusType>;
  setStreamStatus(stream: string, status: StreamStatusOrReadyType): void;
  sendInstructionUpdate(stream: StreamTabId | ''): void;
  updateLogContentForStream(
    stream: string,
    options?: { updateInstruction?: boolean },
  ): void;
}

export interface LogEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

export function createLogEvents(shared: LogEventsShared): LogEventsModule {
  const logHandlerError = (context: string, error: unknown): void => {
    const details =
      error instanceof Error
        ? { message: error.message, stack: error.stack, error }
        : { error };

    shared.logger.error(
      `[LogEvents] ${context}`,
      undefined,
      undefined,
      details,
    );
  };

  const withErrorBoundary = (context: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      logHandlerError(context, error);
    }
  };

  const safelyParseLegacyLogData = (
    data: LogMessageData,
    isUpdate = false,
  ): void => {
    try {
      parseLegacyLogData(data, shared.logger, isUpdate);
    } catch (error) {
      logHandlerError('failed to parse legacy log data', error);
    }
  };

  const handleAddLogMessage = (
    data: ProgressEventPayloads['addLogMessage'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle addLogMessage', () => {
      const { stream, logMessage } = data;

      safelyParseLegacyLogData(logMessage);

      if (
        logMessage.level === 'debug' &&
        !getConfig<boolean>('logger.debugMode', false)
      ) {
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
      } else {
        safelyParseLegacyLogData(existing, true);
      }

      state.streamTabs.save();

      if (updater.isAvailable() && stream === state.activeStream) {
        updater.updateLogMessage(stream, existing);
      }
    });
  };

  const handleAddTaskGroup = (
    data: ProgressEventPayloads['addTaskGroup'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle addTaskGroup', () => {
      const {
        stream,
        groupId,
        groupName,
        startTime,
        status,
        endTime,
        parentGroupId,
      } = data;

      if (!state.streamTabs.has(stream)) {
        shared.logger.debug(`Creating stream from addTaskGroup: ${stream}`);
        state.streamTabs.ensureStream(stream);
        state.setSessionKindHint(stream, AgentSessionKind.Workflow);

        const currentFilter = state.agentTypeFilter;
        if (
          currentFilter !== 'all' &&
          currentFilter !== AgentSessionKind.Workflow
        ) {
          state.agentTypeFilter = AgentSessionKind.Workflow;
        }

        state.activeStream = stream;

        if (!shared.streamStatus.has(stream)) {
          shared.setStreamStatus(stream, STATUS.RUNNING);
        }

        if (updater.isAvailable()) {
          shared.updateLogContentForStream(stream, {
            updateInstruction: false,
          });
          shared.sendInstructionUpdate(stream);
        }
      }

      const group: TaskGroup = {
        id: groupId,
        name: groupName,
        startTime,
        endTime,
        status,
        parentGroupId,
      };

      state.taskGroups.addGroup(stream, groupId, group);

      if (updater.isAvailable() && stream === state.activeStream) {
        updater.addTaskGroup(stream, group);
      }
    });
  };

  const handleUpdateTaskGroup = (
    data: ProgressEventPayloads['updateTaskGroup'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle updateTaskGroup', () => {
      const { stream, groupId, status, endTime } = data;

      state.taskGroups.updateGroup(stream, groupId, {
        status,
        endTime,
      });

      if (updater.isAvailable() && stream === state.activeStream) {
        updater.updateTaskGroup(stream, groupId, status, endTime);
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
        new vscode.Disposable(
          bus.on('addTaskGroup', (payload) =>
            handleAddTaskGroup(payload, state, updater),
          ),
        ),
        new vscode.Disposable(
          bus.on('updateTaskGroup', (payload) =>
            handleUpdateTaskGroup(payload, state, updater),
          ),
        ),
      ];
    },
  };
}
