// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - agent
import { AgentSessionKind } from '@agent/core/AgentDataclass';

// Local imports - events
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

import type { AgentLogger } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';

interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void;
  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

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
  const logHandlerError = (context: string, error: unknown): void => {
    const details =
      error instanceof Error
        ? { message: error.message, stack: error.stack, error }
        : { error };

    shared.logger.error(
      `[TaskGroupEvents] ${context}`,
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

      if (!state.streamTabs.has(stream)) {
        shared.logger.debug(`Creating stream from addTaskGroup: ${stream}`);
        bus.emit('setActiveStream', {
          stream,
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
