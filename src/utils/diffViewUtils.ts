// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { REFRESH_THRESHOLD_MS, DIFF_EDITOR_DELAY_MS } from './constants';

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
  // When view columns change (e.g., switching from split to inline or vice versa),
  // VS Code may reset word wrap. Apply a small delay then ensure word wrap is enabled.
  setTimeout(() => {
    ensureWordWrapEnabled();
  }, DIFF_EDITOR_DELAY_MS);
}

function ensureWordWrapEnabled() {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || !diffInfo) {
    return;
  }

  // Check if the active editor is showing one of our diff files
  const activeUri = activeEditor.document.uri.toString();
  const leftUri = diffInfo.left.toString();
  const rightUri = diffInfo.right.toString();
  
  if (activeUri === leftUri || activeUri === rightUri) {
    // Use command-only approach since config API doesn't detect toggleWordWrap changes
    fallbackWordWrapToggle();
  }
}

function fallbackWordWrapToggle() {
  // This approach uses a smart toggle: turn off then on to ensure consistent state
  vscode.commands.executeCommand('editor.action.toggleWordWrap').then(() => {
    setTimeout(() => {
      vscode.commands.executeCommand('editor.action.toggleWordWrap').then(() => {
        logger.debug(CHANNEL, 'Applied word wrap toggle for diff editor');
      });
    }, DIFF_EDITOR_DELAY_MS);
  });
}

function onVisibleEditorsChange() {
  const info = diffInfo;
  if (!info) {
    return;
  }
  const left = info.left.toString();
  const right = info.right.toString();
  const open = vscode.window.visibleTextEditors.some((editor) => {
    const uri = editor.document.uri.toString();
    return uri === left || uri === right;
  });
  if (!open) {
    disposeDiffRefresh();
  }
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
    vscode.window.onDidChangeVisibleTextEditors(onVisibleEditorsChange),
    vscode.window.onDidChangeActiveTextEditor(() => {
      // When active editor changes (including view mode switches), ensure word wrap
      setTimeout(ensureWordWrapEnabled, DIFF_EDITOR_DELAY_MS);
    }),
    vscode.window.onDidChangeTextEditorViewColumn(onViewColumnChange),
  );
  logger.debug(CHANNEL, 'Registered diff refresh listeners with word wrap protection');
}

export function disposeDiffRefresh() {
  disposables.forEach((d) => d.dispose());
  disposables = [];
  diffInfo = undefined;
  logger.debug(CHANNEL, 'Disposed diff refresh listeners');
}
