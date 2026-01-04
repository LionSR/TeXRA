// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { TODO_STATUS } from '@eventBus/schemas';

// Local file imports
import {
  createStatefulEventDisposable,
  sendIfActive,
  type BaseEventShared,
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

    withErrorBoundary('failed to handle updateTodos', () => {
      const { stream, todos } = data;
      state.setTodos(stream, todos);
      sendIfActive(stream, state, updater, () => {
        updater.updateTodos(stream, todos);
      });
    });
  };

  return {
    register(bus, state, updater) {
      return [
        createStatefulEventDisposable(
          bus,
          'updateTodos',
          state,
          updater,
          handleUpdateTodos,
        ),
      ];
    },
  };
}
