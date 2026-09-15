/**
 * The VS Code host's `StateStore`: a `vscode.Memento` paired with the
 * `StateWriteFailed` its rejected write raises.
 *
 * VS Code's own `Memento` satisfies the port's synchronous `get` but not its
 * `update`, which is an `Effect`: this is the one place that adopts the
 * `Thenable` the editor returns and raises the port's tag for a refusal. It
 * lives here for the same reason `vscodeSetupPlatform` does — the host
 * implementation of a port belongs beside the other host implementations, and
 * the composition root only wires it.
 *
 * One wrapper per Memento; it holds no state of its own.
 */

// Third-party imports
import { Effect } from 'effect';
import type * as vscode from 'vscode';

// Local imports
import { StateWriteFailed, type StateStore } from '@platform/interfaces';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** The port over one of VS Code's own `Memento`s (global or workspace). */
export function mementoStateStore(memento: vscode.Memento): StateStore {
  return {
    get: <T>(key: string, defaultValue?: T): T =>
      memento.get<T>(key, defaultValue as T),
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
