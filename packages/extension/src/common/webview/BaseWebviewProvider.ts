// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { DisposableStore } from '@platform/disposable';

import type { BundledViewContentProvider } from './BaseViewContentProvider';

/**
 * Base class for webview providers.
 * Holds the active view, its content provider, its message handler, and
 * disposable management; each provider wires up its own view (sidebar or
 * panel).
 */
export abstract class BaseWebviewProvider {
  protected _view?: vscode.WebviewView | vscode.WebviewPanel;
  protected readonly _disposables = new DisposableStore();
  protected _viewDisposables = new DisposableStore();

  protected abstract contentProvider: BundledViewContentProvider;

  protected abstract messageHandler: {
    handleMessage(
      message: unknown,
      webviewView: vscode.WebviewView | vscode.WebviewPanel,
    ): Promise<void> | void;
    clearActiveView?(): void;
  };

  constructor(protected readonly context: vscode.ExtensionContext) {}

  /**
   * Render this provider's HTML into `view` and route the view's inbound
   * messages to this provider's handler. The returned disposable removes that
   * listener; callers keep it wherever the listener's lifetime belongs (a view
   * disposable store, or the single slot a swappable surface reassigns).
   *
   * Public because the sidebar is one VS Code view slot two providers share:
   * MainViewProvider hands the slot to the progress view by calling this on
   * ProgressViewProvider.
   */
  public setupWebviewContent(
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): vscode.Disposable {
    view.webview.html = this.contentProvider.getHtmlContent(view.webview);
    return view.webview.onDidReceiveMessage((message) =>
      this.messageHandler.handleMessage(message, view),
    );
  }

  protected cleanupView(): void {
    const disposables = this._viewDisposables;
    this._viewDisposables = new DisposableStore();
    try {
      disposables.dispose();
    } finally {
      this._view = undefined;
      this.messageHandler.clearActiveView?.();
    }
  }

  public dispose(): void {
    try {
      this.cleanupView();
    } finally {
      this._disposables.dispose();
    }
  }
}
