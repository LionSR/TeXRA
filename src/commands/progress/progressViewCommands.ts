import * as vscode from 'vscode';

import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamSort } from '@shared/streams/streamSort';

const SORT_ITEMS: { label: string; sort: StreamSort }[] = [
  { label: 'Sort by Time', sort: 'time' },
  { label: 'Sort by File', sort: 'inputFile' },
  { label: 'Sort by Agent', sort: 'agent' },
];

export function registerProgressViewCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.sortStreams', async () => {
      const provider = ProgressViewProvider.getInstance();
      if (!provider) return;

      const current = provider.state.streamSortOrder;
      const items = SORT_ITEMS.map((item) => ({
        label: item.sort === current ? `$(check) ${item.label}` : item.label,
        sort: item.sort,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Sort Streams',
        placeHolder: 'Choose sort order',
      });

      if (picked) {
        provider.state.streamSortOrder = picked.sort;
        provider.syncFullView();
      }
    }),
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
