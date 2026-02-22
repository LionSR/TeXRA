import * as vscode from 'vscode';

import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

export function registerProgressViewCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.showProgressView', async () => {
      const provider = ProgressViewProvider.getInstance();
      if (!provider) {
        vscode.window.showErrorMessage(
          'Progress View is not available. Please try again.',
        );
        return;
      }
      await provider.showProgressView();
    }),
    vscode.commands.registerCommand('texra.openProgressViewInTab', async () => {
      const provider = ProgressViewProvider.getInstance();
      if (!provider) {
        await vscode.window.showErrorMessage(
          'Progress View is not available. Please try again.',
        );
        return;
      }
      await provider.popOutToEditor();
    }),
  );
}
