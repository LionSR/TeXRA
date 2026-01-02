// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getSharedLocalResourceRoots } from './resourceRoots';

export interface PanelOptions {
  viewType: string;
  title: string;
  viewPath: string;
  column?: vscode.ViewColumn;
  retainContextWhenHidden?: boolean;
}

/**
 * Base class for webview providers.
 * Handles HTML assignment, message routing, and disposable management.
 */
export abstract class BaseWebviewProvider {
  protected _view?: vscode.WebviewView | vscode.WebviewPanel;
  protected readonly _disposables: vscode.Disposable[] = [];
  protected _viewDisposables: vscode.Disposable[] = [];

  protected abstract contentProvider: {
    getHtmlContent(webview: vscode.Webview): string;
  };
  protected abstract messageHandler: {
    handleMessage(
      message: any,
      webviewView: vscode.WebviewView | vscode.WebviewPanel,
    ): Promise<void> | void;
  };

  constructor(protected readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.resolveWebviewViewInternal(webviewView);
  }

  protected resolveWebviewViewInternal(
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): void {
    this.cleanupView();
    this._view = webviewView;

    webviewView.webview.html = this.contentProvider.getHtmlContent(
      webviewView.webview,
    );

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((message) =>
        this.messageHandler.handleMessage(message, webviewView),
      ),
      webviewView.onDidDispose(() => this.cleanupView()),
    );
  }

  protected addViewDisposables(...disposables: vscode.Disposable[]): void {
    this._viewDisposables.push(...disposables);
  }

  /**
   * Create or reveal a webview panel.
   * Common pattern for showing secondary views (History, Profile) as panels.
   * @returns true if panel was created, false if existing panel was revealed
   */
  protected createOrShowPanel(options: PanelOptions): boolean {
    // If we already have a panel, reveal it
    if (this._view && 'reveal' in this._view) {
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

    this.resolveWebviewViewInternal(this._view);
    return true;
  }

  protected cleanupView(): void {
    this._viewDisposables.forEach((d) => d.dispose());
    this._viewDisposables = [];
    this._view = undefined;
  }

  public dispose(): void {
    this.cleanupView();
    this._disposables.forEach((d) => d.dispose());
    this._disposables.length = 0;
  }
}
