// Third-party imports
import * as vscode from 'vscode';

// Base class for webview providers handling common setup and disposal
export abstract class BaseWebviewProvider<
  V extends { webview: vscode.Webview; onDidDispose: vscode.Event<void> },
> implements vscode.Disposable
{
  protected view?: V;
  private viewDisposables: vscode.Disposable[] = [];
  protected contentProvider!: {
    getHtmlContent(webview: vscode.Webview): string;
  };
  protected messageHandler!: {
    handleMessage(message: any, view: V): Promise<void> | void;
  };

  constructor(protected readonly context: vscode.ExtensionContext) {}

  public dispose(): void {
    this.cleanupView();
  }

  protected registerViewDisposable(disposable: vscode.Disposable): void {
    this.viewDisposables.push(disposable);
  }

  protected cleanupView(): void {
    this.viewDisposables.forEach((d) => d.dispose());
    this.viewDisposables = [];
    this.view = undefined;
  }

  public resolveWebviewView(view: V): void {
    this.cleanupView();
    this.view = view;
    view.webview.html = this.contentProvider.getHtmlContent(view.webview);
    this.registerViewDisposable(
      view.webview.onDidReceiveMessage((message) =>
        this.messageHandler.handleMessage(message, view),
      ),
    );
    this.registerViewDisposable(view.onDidDispose(() => this.cleanupView()));
  }
}
