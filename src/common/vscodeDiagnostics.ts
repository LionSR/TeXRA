/**
 * Shared VS Code diagnostics utilities.
 *
 * Provides common helpers for waiting on and working with VS Code diagnostics,
 * used by both Lean and LaTeX tooling.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';

const CHANNEL = 'VscodeDiagnostics';

/**
 * Wait for diagnostics to change for a specific file.
 * Uses event subscription with timeout.
 *
 * @param uri - The file URI to watch for diagnostic changes
 * @param timeoutMs - Maximum time to wait (default 3000ms)
 * @returns Promise that resolves when diagnostics change or timeout
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
