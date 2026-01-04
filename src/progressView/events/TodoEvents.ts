// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import { sendIfActive, type ProgressEventBusLike } from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'TodoEvents';

/**
 * Register todo event handlers.
 */
export function registerTodoEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
): vscode.Disposable[] {
  return [
    new vscode.Disposable(
      bus.on('updateTodos', ({ stream, todos }) => {
        withEventErrorHandling(MODULE, 'failed to handle updateTodos', () => {
          state.setTodos(stream, todos);
          sendIfActive(stream, state, updater, () => {
            updater.updateTodos(stream, todos);
          });
        });
      }),
    ),
  ];
}
