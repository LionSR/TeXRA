import * as vscode from 'vscode';

import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

/**
 * `texra.showProgressView` migrated to the shared command registry in
 * #3781 batch 4. Kept as a no-op for backward compatibility with the
 * existing call list in `commands.ts`.
 */
export function registerProgressViewCommands(
  _context: vscode.ExtensionContext,
): void {
  // Intentionally empty: handler moved to the shared registry (#3781 batch 4).
}

/**
 * Show the progress view. Migrated to the shared command registry in
 * #3781 batch 4. The `inPlace` flag controls whether to keep the
 * sidebar in its current location vs. focusing it.
 */
export async function showProgressView(inPlace: boolean): Promise<void> {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    vscode.window.showErrorMessage(
      'Progress View is not available. Please try again.',
    );
    return;
  }
  await provider.showProgressView({ inPlace });
}

export async function openProgressViewInTab(): Promise<void> {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    await vscode.window.showErrorMessage(
      'Progress View is not available. Please try again.',
    );
    return;
  }
  await provider.popOutToEditor();
}
