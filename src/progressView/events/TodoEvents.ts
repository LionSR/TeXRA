// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import {
  createStatefulEventDisposable,
  sendIfActive,
  type ProgressEventBusLike,
  type StatefulEventModule,
} from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'TodoEvents';

export type TodoEventsModule = StatefulEventModule;

const handleUpdateTodos = (
  data: ProgressEventPayloads['updateTodos'],
  state: ProgressViewState,
  updater: WebviewUpdater,
): void => {
  withEventErrorHandling(MODULE, 'failed to handle updateTodos', () => {
    const { stream, todos } = data;
    state.setTodos(stream, todos);
    sendIfActive(stream, state, updater, () => {
      updater.updateTodos(stream, todos);
    });
  });
};

/**
 * Create todo event module for registration.
 */
export function createTodoEvents(_shared: unknown = {}): TodoEventsModule {
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
