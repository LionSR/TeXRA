/**
 * VS Code diagnostics utilities.
 *
 * Provides VS Code-specific helpers (waiting on diagnostic events).
 * For formatting, import directly from `@utils/diagnostics/diagnosticFormatting`.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';

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

  await new Promise<void>((resolve) => {
    let settled = false;

    const disposable = vscode.languages.onDidChangeDiagnostics((event) => {
      const hasMatch = event.uris.some(
        (eventUri) => eventUri.toString().toLowerCase() === targetKey,
      );
      if (hasMatch) {
        finish();
      }
    });

    const timeoutHandle = setTimeout(() => {
      logger.debug(CHANNEL, `Timed out waiting for diagnostics: ${uri.fsPath}`);
      finish();
    }, timeoutMs);

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      disposable.dispose();
      resolve();
    }
  });
}
