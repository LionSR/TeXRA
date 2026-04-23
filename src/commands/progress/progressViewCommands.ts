import * as vscode from 'vscode';

import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamSort } from '@shared/streams/streamSort';

function applySortOrder(sort: StreamSort): void {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) return;
  provider.state.streamSortOrder = sort;
  provider.syncFullView();
  vscode.commands.executeCommand('setContext', 'texra.streamSort', sort);
}

export function registerProgressViewCommands(
  context: vscode.ExtensionContext,
): void {
  // Set initial context key so submenu checkmarks are correct on activation.
  const provider = ProgressViewProvider.getInstance();
  const initialSort = provider?.state.streamSortOrder ?? 'time';
  vscode.commands.executeCommand('setContext', 'texra.streamSort', initialSort);

  context.subscriptions.push(
    vscode.commands.registerCommand('texra.sortByTime', () =>
      applySortOrder('time'),
    ),
    vscode.commands.registerCommand('texra.sortByFile', () =>
      applySortOrder('inputFile'),
    ),
    vscode.commands.registerCommand('texra.sortByAgent', () =>
      applySortOrder('agent'),
    ),
    vscode.commands.registerCommand('texra.sortByTimeActive', () =>
      applySortOrder('time'),
    ),
    vscode.commands.registerCommand('texra.sortByFileActive', () =>
      applySortOrder('inputFile'),
    ),
    vscode.commands.registerCommand('texra.sortByAgentActive', () =>
      applySortOrder('agent'),
    ),
    vscode.commands.registerCommand(
      'texra.showProgressView',
      async (options?: unknown) => {
        const inPlace =
          typeof options === 'object' &&
          options !== null &&
          'inPlace' in options &&
          (options as { inPlace?: boolean }).inPlace === true;

        const provider = ProgressViewProvider.getInstance();
        if (!provider) {
          vscode.window.showErrorMessage(
            'Progress View is not available. Please try again.',
          );
          return;
        }
        await provider.showProgressView({ inPlace });
      },
    ),
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
