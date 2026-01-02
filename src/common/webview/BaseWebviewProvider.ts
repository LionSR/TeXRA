// Third-party imports
import * as vscode from 'vscode';

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
      webviewView.onDidDispose(this.cleanupView.bind(this)),
    );
  }

  protected addViewDisposables(...disposables: vscode.Disposable[]): void {
    this._viewDisposables.push(...disposables);
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
