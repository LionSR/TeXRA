import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { REFRESH_THRESHOLD_MS } from '@utils/config/constants';

const CHANNEL = 'DiffRefresh';

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
  logger.debug(CHANNEL, 'Refreshed diff view');
}

export function registerDiffRefresh(
  left: vscode.Uri,
  right: vscode.Uri,
  title: string,
): void {
  refreshListener?.dispose();
  diffInfo = { left, right, title };
  refreshListener = vscode.window.onDidChangeTextEditorViewColumn(refreshDiff);
  logger.debug(CHANNEL, 'Registered diff refresh listeners');
}

export function disposeDiffRefresh(): void {
  refreshListener?.dispose();
  refreshListener = undefined;
  diffInfo = undefined;
  logger.debug(CHANNEL, 'Disposed diff refresh listeners');
}
