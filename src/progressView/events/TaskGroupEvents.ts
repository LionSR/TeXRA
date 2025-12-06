// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { TaskGroup } from '@logger/LogTypes';
import type {
  TaskGroupUpdatePayload,
  WebviewUpdater,
} from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type {
  BaseEventShared,
  ProgressEventBusLike,
  StatefulEventModule,
} from './types';

/**
 * Shared context for TaskGroupEvents module.
 * Extends BaseEventShared with task group initialization callback.
 * Also requires debugLog for verbose logging during stream creation.
 */
interface TaskGroupEventsShared extends BaseEventShared {
  initializeStreamForTaskGroup(stream: string): Promise<void>;
  debugLog(message: string): void;
}

/**
 * TaskGroupEvents module interface.
 * Uses StatefulEventModule pattern for state/updater access.
 */
export type TaskGroupEventsModule = StatefulEventModule;

export function createTaskGroupEvents(
  shared: TaskGroupEventsShared,
): TaskGroupEventsModule {
  const { withErrorBoundary, debugLog } = shared;

  const handleAddTaskGroup = (
    data: ProgressEventPayloads['addTaskGroup'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle addTaskGroup', async () => {
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
        debugLog(`Creating stream from addTaskGroup: ${stream}`);
        await shared.initializeStreamForTaskGroup(stream);
      }

      const group: TaskGroup = {
        id: groupId,
        name: groupName,
        startTime,
        endTime,
        status,
        parentGroupId,
      };

      const addGroupPromise = state.taskGroups.addGroup(stream, groupId, group);

      try {
        if (!parentGroupId) {
          state.setActiveRunId(stream, groupId);
        }

        if (updater.isAvailable() && stream === state.activeStream) {
          updater.addTaskGroup(stream, group);
        }
      } finally {
        await addGroupPromise;
      }
    });
  };

  const handleUpdateTaskGroup = (
    data: ProgressEventPayloads['updateTaskGroup'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    withErrorBoundary('failed to handle updateTaskGroup', async () => {
      const update: TaskGroupUpdatePayload = {
        stream: data.stream,
        groupId: data.groupId,
        updates: {
          status: data.status,
          endTime: data.endTime,
        },
      };

      await state.taskGroups.updateGroup(update);

      if (updater.isAvailable() && data.stream === state.activeStream) {
        updater.updateTaskGroup(update);
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
