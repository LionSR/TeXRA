// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import {
  sendIfActive,
  type ProgressEventBusLike,
  type Unsubscribe,
} from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'TodoEvents';

/**
 * Register todo event handlers.
 * Returns unsubscribe functions - caller handles VSCode Disposable wrapping.
 */
export function registerTodoEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
): Unsubscribe[] {
  return [
    bus.on('updateTodos', ({ stream, todos }) => {
      withEventErrorHandling(MODULE, 'failed to handle updateTodos', () => {
        state.setTodos(stream, todos);
        sendIfActive(stream, state, updater, () => {
          updater.updateTodos(stream, todos);
        });
      });
    }),
  ];
}
