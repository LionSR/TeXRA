// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local imports - constants
import { TODO_STATUS } from '@eventBus/schemas';

// Local file imports
import {
  registerStatefulEvents,
  type BaseEventShared,
  type ProgressEventBusLike,
  type StatefulEventModule,
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
    const inProgress = data.todos.filter(
      (t) => t.status === TODO_STATUS.IN_PROGRESS,
    ).length;
    debugLog(
      `updateTodos: stream=${data.stream}, count=${todoCount}, inProgress=${inProgress}`,
    );

    const { stream, todos } = data;

    // Always store todos in state for persistence across stream switches
    state.setTodos(stream, todos);

    // Send to webview if it's the active stream and webview is available
    const shouldSendToWebview =
      updater.isAvailable() && stream === state.activeStream;

    if (shouldSendToWebview) {
      updater.updateTodos(stream, todos);
    }
  };

  return {
    register(bus, state, updater) {
      return registerStatefulEvents(bus, state, updater, withErrorBoundary, [
        {
          event: 'updateTodos',
          errorMessage: 'failed to handle updateTodos',
          handler: handleUpdateTodos,
        },
      ]);
    },
  };
}
