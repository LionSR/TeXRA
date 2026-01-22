// Third-party imports
import * as vscode from 'vscode';

// Internal imports
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

const CHANNEL = 'progressViewCommands';

export function registerProgressViewCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.showProgressView', () =>
      safeExecuteCommand('texra.progressView.focus', [], CHANNEL),
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
