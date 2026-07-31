/**
 * VS Code diagnostics utilities.
 *
 * Provides VS Code-specific helpers (waiting on diagnostic events).
 * For formatting, import directly from `@utils/diagnostics/diagnosticFormatting`.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';

import { raceWithTimeout } from './raceWithTimeout';

const CHANNEL = 'VscodeDiagnostics';

export { DiagnosticSeverity } from 'vscode';

/**
 * Wait for diagnostics to change for a specific file.
 * Uses event subscription with timeout.
 */
export async function waitForDiagnosticsChange(
  uri: vscode.Uri,
  timeoutMs: number = 3000,
): Promise<void> {
  if (timeoutMs <= 0) {
    return;
  }

  const targetKey = uri.toString().toLowerCase();

  const raced = await raceWithTimeout<void>(
    (resolve) =>
      vscode.languages.onDidChangeDiagnostics((event) => {
        const hasMatch = event.uris.some(
          (eventUri) => eventUri.toString().toLowerCase() === targetKey,
        );
        if (hasMatch) resolve();
      }),
    timeoutMs,
  );

  if (raced.timedOut) {
    logger.debug(CHANNEL, `Timed out waiting for diagnostics: ${uri.fsPath}`);
  }
}
