// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type {
  BaseEventShared,
  ProgressEventBusLike,
  StatefulEventModule,
} from './types';

/**
 * Shared context for TodoEvents module.
 * Extends BaseEventShared with debug logging.
 */
interface TodoEventsShared extends BaseEventShared {
  debugLog(message: string): void;
}

/**
 * TodoEvents module interface.
 * Uses StatefulEventModule pattern for state/updater access.
 */
export type TodoEventsModule = StatefulEventModule;

export function createTodoEvents(shared: TodoEventsShared): TodoEventsModule {
  const { withErrorBoundary, debugLog } = shared;

  const handleUpdateTodos = (
    data: ProgressEventPayloads['updateTodos'],
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): void => {
    const todoCount = data.todos.length;
    const inProgress = data.todos.filter((t) => t.status === 'in_progress').length;
    debugLog(
      `updateTodos: stream=${data.stream}, count=${todoCount}, inProgress=${inProgress}`,
    );

    withErrorBoundary('failed to handle updateTodos', async () => {
      const { stream, todos } = data;

      // Only send to webview if it's the active stream
      const shouldSendToWebview =
        updater.isAvailable() && stream === state.activeStream;

      if (shouldSendToWebview) {
        updater.updateTodos(stream, todos);
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
          bus.on('updateTodos', (payload) =>
            handleUpdateTodos(payload, state, updater),
          ),
        ),
      ];
    },
  };
}
