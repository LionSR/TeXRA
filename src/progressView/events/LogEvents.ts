// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// @ts-ignore - Import JavaScript module
import { STATUS } from '../modules/constants.js';

// Local imports - events
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

// Local imports - logger
import { parseLegacyLogData } from '@logger/logUtils';
import type { LogMessageUpdate, TaskGroup } from '@logger/LogTypes';
import { getConfig } from '@utils/config';

import type {
  StatusType,
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
  activateStream(
    payload: ProgressEventPayloads['setActiveStream'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void;
  setStreamStatus(stream: string, status: StreamStatusOrReadyType): void;
}

export interface LogEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

export function createLogEvents(shared: LogEventsShared): LogEventsModule {
  const handleAddLogMessage = (
    data: ProgressEventPayloads['addLogMessage'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    const { stream, logMessage } = data;

    parseLegacyLogData(logMessage, shared.logger);

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
  };

  const handleUpdateLogMessage = (
    data: ProgressEventPayloads['updateLogMessage'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
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
      parseLegacyLogData(existing, shared.logger, true);
    }

    state.streamTabs.save();

    if (updater.isAvailable() && stream === state.activeStream) {
      updater.updateLogMessage(stream, existing);
    }
  };

  const handleAddTaskGroup = (
    data: ProgressEventPayloads['addTaskGroup'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
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
      if (!shared.streamStatus.has(stream)) {
        shared.setStreamStatus(stream, STATUS.RUNNING);
      }
      shared.activateStream({ stream }, state, updater);
    }

    const group: TaskGroup = {
      id: groupId,
      name: groupName,
      startTime,
      endTime,
      status: status as StatusType,
      parentGroupId,
    };

    state.taskGroups.addGroup(stream, groupId, group);

    if (updater.isAvailable() && stream === state.activeStream) {
      updater.addTaskGroup(stream, group);
    }
  };

  const handleUpdateTaskGroup = (
    data: ProgressEventPayloads['updateTaskGroup'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    const { stream, groupId, status, endTime } = data;

    state.taskGroups.updateGroup(stream, groupId, {
      status: status as StatusType,
      endTime,
    });

    if (updater.isAvailable() && stream === state.activeStream) {
      updater.updateTaskGroup(stream, groupId, status as StatusType, endTime);
    }
  };

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      return [
        new vscode.Disposable((
          bus.on('addLogMessage', (payload) =>
            handleAddLogMessage(payload, state, updater),
          )
        )),
        new vscode.Disposable((
          bus.on('updateLogMessage', (payload) =>
            handleUpdateLogMessage(payload, state, updater),
          )
        )),
        new vscode.Disposable((
          bus.on('addTaskGroup', (payload) =>
            handleAddTaskGroup(payload, state, updater),
          )
        )),
        new vscode.Disposable((
          bus.on('updateTaskGroup', (payload) =>
            handleUpdateTaskGroup(payload, state, updater),
          )
        )),
      ];
    },
  };
}
