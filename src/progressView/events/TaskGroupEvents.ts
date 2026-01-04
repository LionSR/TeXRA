// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { TaskGroup } from '@logger/LogTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import type { ProgressEventBusLike } from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'TaskGroupEvents';

/**
 * Callbacks for task group event handling.
 */
export interface TaskGroupCallbacks {
  initializeStreamForTaskGroup(stream: string): Promise<void>;
  debugLog(message: string): void;
  bufferTaskGroupForReplay(stream: string, group: TaskGroup): void;
}

/**
 * Register task group event handlers.
 */
export function registerTaskGroupEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  callbacks: TaskGroupCallbacks,
): vscode.Disposable[] {
  const { debugLog } = callbacks;

  return [
    new vscode.Disposable(
      bus.on('addTaskGroup', (data) => {
        debugLog(
          `addTaskGroup: id=${data.id}, name=${data.name}, parentGroupId=${data.parentGroupId ?? 'none'}, stream=${data.stream}`,
        );

        withEventErrorHandling(
          MODULE,
          'failed to handle addTaskGroup',
          async () => {
            const { stream, ...group } = data;
            const { id, parentGroupId } = group;

            const hasStream = state.streamTabs.has(stream);

            // Add group to state BEFORE initializeStreamForTaskGroup, so that
            // refreshStreamSurface (called inside) includes this group in UPDATE_LOGS.
            // addGroup synchronously adds to in-memory state; save is async.
            const addGroupPromise = state.taskGroups.addGroup(stream, id, group);

            if (!parentGroupId) {
              state.setActiveRunId(stream, id);
            }

            if (!hasStream) {
              debugLog(`Creating stream from addTaskGroup: ${stream}`);
              // Initialize stream after group is in state. This sends UPDATE_LOGS
              // with forceRebuild: true, which will include the new group.
              await callbacks.initializeStreamForTaskGroup(stream);
            }

            // Send ADD_TASK_GROUP to frontend only if this stream is currently active.
            // If the stream isn't active yet (addTaskGroup arrived before setActiveStream),
            // buffer the group for replay when setActiveStream is processed.
            // This fixes the race condition where Init groups are dropped by the frontend
            // because state.activeStream isn't set when the ADD_TASK_GROUP message arrives.
            if (updater.isAvailable()) {
              if (stream === state.activeStream) {
                updater.addTaskGroup(stream, group);
              } else {
                debugLog(
                  `Buffering task group ${id} for stream ${stream} (activeStream=${state.activeStream})`,
                );
                callbacks.bufferTaskGroupForReplay(stream, group);
              }
            }

            // Ensure group persistence completes
            await addGroupPromise;
          },
        );
      }),
    ),
    new vscode.Disposable(
      bus.on('updateTaskGroup', (data) => {
        debugLog(
          `updateTaskGroup: id=${data.id}, status=${data.status}, stream=${data.stream}`,
        );

        withEventErrorHandling(
          MODULE,
          'failed to handle updateTaskGroup',
          async () => {
            // Pass event data directly - no transformation needed
            await state.taskGroups.updateGroup(data);

            const shouldSendToWebview =
              updater.isAvailable() && data.stream === state.activeStream;
            debugLog(
              `updateTaskGroup: shouldSendToWebview=${shouldSendToWebview}, activeStream=${state.activeStream}`,
            );

            if (shouldSendToWebview) {
              updater.updateTaskGroup(data);
            }
          },
        );
      }),
    ),
  ];
}
