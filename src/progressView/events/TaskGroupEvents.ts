// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

import type { AgentLogger } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';

interface TaskGroupEventsShared {
  logger: AgentLogger;
  initializeStreamForTaskGroup(stream: string): void;
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
        shared.initializeStreamForTaskGroup(stream);
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
      if (!parentGroupId) {
        state.setLatestSessionGroup(stream, groupId);
      }

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
