// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { DisposableStore } from '@platform/disposable';
import { getSharedLocalResourceRoots } from './resourceRoots';

export interface PanelOptions {
  viewType: string;
  title: string;
  viewPath: string;
  column?: vscode.ViewColumn;
  retainContextWhenHidden?: boolean;
  iconPath?: vscode.IconPath;
}

/**
 * Base class for webview providers.
 * Handles HTML assignment, message routing, and disposable management.
 */
export abstract class BaseWebviewProvider {
  protected _view?: vscode.WebviewView | vscode.WebviewPanel;
  protected readonly _disposables = new DisposableStore();
  protected _viewDisposables = new DisposableStore();

  protected abstract contentProvider: {
    getHtmlContent(webview: vscode.Webview): string;
  };
  protected abstract messageHandler: {
    handleMessage(
      message: unknown,
      webviewView: vscode.WebviewView | vscode.WebviewPanel,
    ): Promise<void> | void;
    clearActiveView?(): void;
  };

  constructor(protected readonly context: vscode.ExtensionContext) {}

  protected resolveWebviewViewInternal(
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): void {
    this.cleanupView();
    this._view = webviewView;

    webviewView.webview.html = this.contentProvider.getHtmlContent(
      webviewView.webview,
    );

    this._viewDisposables.add(
      webviewView.webview.onDidReceiveMessage((message) =>
        this.messageHandler.handleMessage(message, webviewView),
      ),
    );
    this._viewDisposables.add(
      webviewView.onDidDispose(this.cleanupView.bind(this)),
    );
  }

  /**
   * Create or reveal a webview panel.
   * Common pattern for showing secondary views (History, Profile) as panels.
   * @returns true if panel was created, false if existing panel was revealed
   */
  protected createOrShowPanel(options: PanelOptions): boolean {
    // If we already have a panel (not a sidebar WebviewView), reveal it.
    // Check for 'viewColumn' which is unique to WebviewPanel (WebviewView doesn't have it).
    if (this._view && 'viewColumn' in this._view) {
      this._view.reveal(options.column ?? vscode.ViewColumn.One);
      return false;
    }

    // Otherwise, create a new panel
    this._view = vscode.window.createWebviewPanel(
      options.viewType,
      options.title,
      options.column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: options.retainContextWhenHidden ?? true,
        localResourceRoots: getSharedLocalResourceRoots(
          this.context,
          options.viewPath,
        ),
      },
    );

    if (options.iconPath) {
      this._view.iconPath = options.iconPath;
    }
    this.resolveWebviewViewInternal(this._view);
    return true;
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
