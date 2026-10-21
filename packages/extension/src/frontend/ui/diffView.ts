import * as vscode from 'vscode';

import { createFlushableDebounce } from '@texra/utils/core/flushableDebounce';

/** How long a burst of view-column changes settles before one refresh. */
const REFRESH_SETTLE_MS = 200;

interface DiffInfo {
  left: vscode.Uri;
  right: vscode.Uri;
  title: string;
}

let refreshListener: vscode.Disposable | undefined;
let diffInfo: DiffInfo | undefined;

// Trailing-edge: a column move fires several events within a few
// milliseconds, and a leading throttle that dropped the later ones left the
// diff where the first event found it. The last event always refreshes.
const refreshDiff = createFlushableDebounce(() => {
  if (!diffInfo) {
    return;
  }
  void vscode.commands.executeCommand(
    'vscode.diff',
    diffInfo.left,
    diffInfo.right,
    diffInfo.title,
    { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
  );
}, REFRESH_SETTLE_MS);

export function registerDiffRefresh(
  left: vscode.Uri,
  right: vscode.Uri,
  title: string,
): void {
  refreshListener?.dispose();
  diffInfo = { left, right, title };
  refreshListener = vscode.window.onDidChangeTextEditorViewColumn(() =>
    refreshDiff.schedule(),
  );
}

export function disposeDiffRefresh(): void {
  refreshListener?.dispose();
  refreshListener = undefined;
  refreshDiff.cancel();
  diffInfo = undefined;
}
