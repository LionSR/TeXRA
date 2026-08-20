// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { DisposableStore } from '@platform/disposable';

/**
 * Base class for webview providers.
 * Holds the active view, its message handler, and disposable management;
 * each provider wires up its own view (sidebar or panel).
 */
export abstract class BaseWebviewProvider {
  protected _view?: vscode.WebviewView | vscode.WebviewPanel;
  protected readonly _disposables = new DisposableStore();
  protected _viewDisposables = new DisposableStore();

  protected abstract messageHandler: {
    handleMessage(
      message: unknown,
      webviewView: vscode.WebviewView | vscode.WebviewPanel,
    ): Promise<void> | void;
    clearActiveView?(): void;
  };

  constructor(protected readonly context: vscode.ExtensionContext) {}

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
