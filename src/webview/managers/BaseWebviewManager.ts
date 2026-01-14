// Third-party imports
import * as vscode from 'vscode';

/**
 * Base class for webview managers that need to post messages to the webview.
 * Provides common webview attachment and message posting patterns.
 */
export abstract class BaseWebviewManager {
  protected webview: vscode.WebviewView | undefined;
  protected abstract readonly channel: string;

  attachWebview(webviewView: vscode.WebviewView): void {
    this.webview = webviewView;
  }

  /** Get the attached webview, or undefined if not attached */
  protected getWebview(): vscode.WebviewView | undefined {
    return this.webview;
  }

  /** Post a message to the webview if attached */
  protected postMessage(message: {
    command: string;
    [key: string]: unknown;
  }): void {
    this.webview?.webview.postMessage(message);
  }
}
