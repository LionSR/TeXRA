/**
 * VS Code diagnostics utilities.
 *
 * Provides VS Code-specific helpers (waiting on diagnostic events).
 * For formatting, import directly from `@utils/diagnostics/diagnosticFormatting`.
 */

import { Effect, Option } from 'effect';
import * as vscode from 'vscode';

import { createLog } from '@logger/logUtils';

const log = createLog('VscodeDiagnostics');

/**
 * Wait for diagnostics to change for a specific file, giving up after
 * `timeoutMs`.
 *
 * Nothing subscribes until this effect runs, so a caller that must not miss
 * an update triggered by its own action forks it with `startImmediately`
 * before taking that action and joins the fiber afterwards. Interrupting the
 * wait disposes the subscription.
 */
export function waitForDiagnosticsChange(
  uri: vscode.Uri,
  timeoutMs: number = 3000,
): Effect.Effect<void> {
  if (timeoutMs <= 0) {
    return Effect.void;
  }

  const targetKey = uri.toString().toLowerCase();

  return Effect.callback<void>((resume) => {
    // One disposal path for every exit: Effect runs the returned effect only
    // when the wait is interrupted (the timeout below, or the whole program
    // being interrupted), so the event that resumes normally unsubscribes
    // itself. `dispose` drops the subscription it disposed, so both paths
    // can run.
    let subscription: vscode.Disposable | undefined;
    const dispose = () => {
      subscription?.dispose();
      subscription = undefined;
    };
    subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      const hasMatch = event.uris.some(
        (eventUri) => eventUri.toString().toLowerCase() === targetKey,
      );
      if (hasMatch) {
        dispose();
        resume(Effect.void);
      }
    });
    return Effect.sync(dispose);
  }).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.tap((observed) =>
      Option.isNone(observed)
        ? Effect.sync(() =>
            log.debug(`Timed out waiting for diagnostics: ${uri.fsPath}`),
          )
        : Effect.void,
    ),
    Effect.asVoid,
  );
}
