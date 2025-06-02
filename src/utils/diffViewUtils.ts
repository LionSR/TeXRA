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

function onConfigChange(e: vscode.ConfigurationChangeEvent) {
  if (e.affectsConfiguration('editor.wordWrap')) {
    refreshDiff();
  }
}

function onViewColumnChange() {
  // When view columns change (e.g., switching from split to inline or vice versa),
  // VS Code may reset word wrap. Apply a small delay then ensure word wrap is enabled.
  setTimeout(() => {
    ensureWordWrapEnabled();
  }, 100);
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
    // Try to enable word wrap through configuration first
    try {
      const config = vscode.workspace.getConfiguration('editor', activeEditor.document.uri);
      const currentWordWrap = config.get('wordWrap');
      
      if (currentWordWrap !== 'on') {
        // Try to update the configuration
        config.update('wordWrap', 'on', vscode.ConfigurationTarget.WorkspaceFolder).then(() => {
          logger.debug(CHANNEL, 'Updated word wrap configuration for diff editor');
        }).catch(() => {
          // If configuration update fails, fall back to command
          fallbackWordWrapToggle();
        });
      } else {
        // Configuration says it's on, but might not be applied in diff editor
        // Force a refresh by toggling twice with proper timing
        fallbackWordWrapToggle();
      }
    } catch (error) {
      // Configuration approach failed, use command approach
      fallbackWordWrapToggle();
    }
  }
}

function fallbackWordWrapToggle() {
  // This approach uses a smart toggle: turn off then on to ensure consistent state
  vscode.commands.executeCommand('editor.action.toggleWordWrap').then(() => {
    setTimeout(() => {
      vscode.commands.executeCommand('editor.action.toggleWordWrap').then(() => {
        logger.debug(CHANNEL, 'Applied word wrap toggle fallback for diff editor');
      });
    }, 100);
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
    vscode.workspace.onDidChangeConfiguration(onConfigChange),
    vscode.window.onDidChangeVisibleTextEditors(onVisibleEditorsChange),
    vscode.window.onDidChangeActiveTextEditor(() => {
      // When active editor changes (including view mode switches), ensure word wrap
      setTimeout(ensureWordWrapEnabled, 100);
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
