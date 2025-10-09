// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

import { STATUS } from '../modules/constants.js';

// Local imports - agent
import { AgentSessionKind } from '@agent/core/AgentDataclass';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

import type { AgentLogger } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';

interface TaskGroupEventsShared {
  logger: AgentLogger;
}

export interface TaskGroupEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

export function createTaskGroupEvents(
  shared: TaskGroupEventsShared,
): TaskGroupEventsModule {
  const withErrorBoundary = createErrorBoundary(
    shared.logger,
    'TaskGroupEvents',
  );

  const handleAddTaskGroup = (
    data: ProgressEventPayloads['addTaskGroup'],
    state: ProgressViewState,
    updater: WebviewUpdater,
    bus: ProgressEventBusLike,
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

      const hasStream = state.streamTabs.has(stream);
      if (!hasStream) {
        shared.logger.debug(`Creating stream from addTaskGroup: ${stream}`);
        state.streamTabs.ensureStream(stream);
        bus.emit('updateStreamStatus', {
          stream,
          status: STATUS.RUNNING,
        });
        bus.emit('setActiveStream', {
          stream,
          agentType: null,
          agentSessionKind: AgentSessionKind.Workflow,
        });
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
          bus.on('addTaskGroup', (payload) =>
            handleAddTaskGroup(payload, state, updater, bus),
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
