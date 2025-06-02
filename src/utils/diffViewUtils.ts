// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { REFRESH_THRESHOLD_MS } from './constants';

const CHANNEL = 'DiffRefresh';
logger.initialize(CHANNEL);

let disposables: vscode.Disposable[] = [];
let diffInfo:
  | { left: vscode.Uri; right: vscode.Uri; title: string }
  | undefined;
let lastRefresh = 0;

function refreshDiff() {
  if (!diffInfo) {
    return;
  }
  const now = Date.now();
  if (now - lastRefresh < REFRESH_THRESHOLD_MS) {
    return;
  }
  lastRefresh = now;
  vscode.commands.executeCommand(
    'vscode.diff',
    diffInfo.left,
    diffInfo.right,
    diffInfo.title,
  );
  logger.debug(CHANNEL, 'Refreshed diff view');
}

function onVisibleRangeChange(e: vscode.TextEditorVisibleRangesChangeEvent) {
  if (!diffInfo) {
    return;
  }
  if (!vscode.window.visibleTextEditors.includes(e.textEditor)) {
    return;
  }
  refreshDiff();
}

// Note: Configuration change listener removed as editor.action.toggleWordWrap
// command doesn't update the configuration that can be read via Configuration API

function onViewColumnChange() {
  refreshDiff();
}

export function registerDiffRefresh(
  left: vscode.Uri,
  right: vscode.Uri,
  title: string,
) {
  diffInfo = { left, right, title };
  disposables.forEach((d) => d.dispose());
  disposables = [];

  disposables.push(
    vscode.window.onDidChangeTextEditorVisibleRanges(onVisibleRangeChange),
    vscode.window.onDidChangeTextEditorViewColumn(onViewColumnChange),
  );
  logger.debug(CHANNEL, 'Registered diff refresh listeners');
}

export function disposeDiffRefresh() {
  disposables.forEach((d) => d.dispose());
  disposables = [];
  diffInfo = undefined;
  logger.debug(CHANNEL, 'Disposed diff refresh listeners');
}
