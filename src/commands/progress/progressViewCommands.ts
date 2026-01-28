import * as vscode from 'vscode';

import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

export function registerProgressViewCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.showProgressView', () =>
      vscode.commands.executeCommand('texra.progressView.focus'),
    ),
    vscode.commands.registerCommand('texra.openProgressViewInTab', () => {
      const provider = ProgressViewProvider.getInstance();
      if (!provider) {
        vscode.window.showErrorMessage(
          'Progress View is not available. Please try again.',
        );
        return;
      }
      provider.showProgressViewAsPanel();
    }),
  );
}
