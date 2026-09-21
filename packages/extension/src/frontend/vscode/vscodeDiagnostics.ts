/**
 * VS Code diagnostics utilities.
 *
 * Provides VS Code-specific helpers (waiting on diagnostic events).
 * For formatting, import directly from `@utils/diagnostics/diagnosticFormatting`.
 */

import { Effect, Option } from 'effect';
import * as vscode from 'vscode';

import { withLogChannel } from '@logger/effectLog';

import { firstEventOrTimeout } from './vscodeEventWait';

const CHANNEL = 'VscodeDiagnostics';

/**
 * Wait for diagnostics to change for a specific file, giving up after
 * `timeoutMs`.
 *
 * Nothing subscribes until this effect runs, so a caller that must not miss
 * an update its own next action triggers forks it with `startImmediately`
 * before taking that action and joins the fiber afterwards.
 */
export function waitForDiagnosticsChange(
  uri: vscode.Uri,
  timeoutMs: number = 3000,
): Effect.Effect<void> {
  if (timeoutMs <= 0) {
    return Effect.void;
  }

  const targetKey = uri.toString().toLowerCase();

  return firstEventOrTimeout<void>(
    (report) =>
      vscode.languages.onDidChangeDiagnostics((event) => {
        const hasMatch = event.uris.some(
          (eventUri) => eventUri.toString().toLowerCase() === targetKey,
        );
        if (hasMatch) report();
      }),
    timeoutMs,
  ).pipe(
    Effect.tap((observed) =>
      Option.isNone(observed)
        ? Effect.logDebug(
            `Timed out waiting for diagnostics: ${uri.fsPath}`,
          ).pipe(withLogChannel(CHANNEL))
        : Effect.void,
    ),
    Effect.asVoid,
  );
}
