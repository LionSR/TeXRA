import * as vscode from 'vscode';

import { REFRESH_THRESHOLD_MS } from '@utils/config/constants';

interface DiffInfo {
  left: vscode.Uri;
  right: vscode.Uri;
  title: string;
}

let refreshListener: vscode.Disposable | undefined;
let diffInfo: DiffInfo | undefined;
let lastRefresh = 0;

function refreshDiff(): void {
  if (!diffInfo) {
    return;
  }
  const now = Date.now();
  if (now - lastRefresh < REFRESH_THRESHOLD_MS) {
    return;
  }
  lastRefresh = now;
  void vscode.commands.executeCommand(
    'vscode.diff',
    diffInfo.left,
    diffInfo.right,
    diffInfo.title,
    { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
  );
}

export function registerDiffRefresh(
  left: vscode.Uri,
  right: vscode.Uri,
  title: string,
): void {
  refreshListener?.dispose();
  diffInfo = { left, right, title };
  // A new diff starts its own throttle window: keeping the previous diff's
  // timestamp would swallow this diff's first refresh.
  lastRefresh = 0;
  refreshListener = vscode.window.onDidChangeTextEditorViewColumn(refreshDiff);
}

export function disposeDiffRefresh(): void {
  refreshListener?.dispose();
  refreshListener = undefined;
  diffInfo = undefined;
}
