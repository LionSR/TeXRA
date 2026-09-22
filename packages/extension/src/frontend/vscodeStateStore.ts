/**
 * Effect state reads and writes over one VS Code Memento. This host boundary
 * adopts synchronous reads and Thenable writes, raising typed failures.
 * It holds no copy of the editor's state.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  StateReadFailed,
  StateWriteFailed,
  type StateStore,
} from '@platform/interfaces';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type * as vscode from 'vscode';

/** The port over one of VS Code's own `Memento`s (global or workspace). */
export function mementoStateStore(memento: vscode.Memento): StateStore {
  return {
    get: <T>(key: string, defaultValue?: T) =>
      Effect.try({
        try: () => memento.get<T>(key, defaultValue as T),
        catch: (cause) =>
          new StateReadFailed({
            key,
            message: `VS Code could not read state "${key}": ${toErrorMessage(cause)}`,
            cause,
          }),
      }),
    update: (key, value) =>
      Effect.tryPromise({
        try: () => Promise.resolve(memento.update(key, value)),
        catch: (cause) =>
          new StateWriteFailed({
            key,
            message: `VS Code refused the state write of "${key}": ${toErrorMessage(cause)}`,
            cause,
          }),
      }),
  };
}
