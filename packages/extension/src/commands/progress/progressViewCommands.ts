import * as vscode from 'vscode';

import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

function getProgressProviderOrWarn(): ProgressViewProvider | undefined {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    void vscode.window.showErrorMessage(
      'Progress View is not available. Please try again.',
    );
  }
  return provider;
}

/**
 * Show the progress view. The `inPlace` flag controls whether to keep the
 * sidebar in its current location vs. focusing it.
 */
export async function showProgressView(inPlace: boolean): Promise<void> {
  const provider = getProgressProviderOrWarn();
  if (!provider) return;
  await provider.showProgressView({ inPlace });
}

export async function openProgressViewInTab(): Promise<void> {
  const provider = getProgressProviderOrWarn();
  if (!provider) return;
  await provider.popOutToEditor();
}
