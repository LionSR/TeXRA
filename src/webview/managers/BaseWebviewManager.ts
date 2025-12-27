// Third-party imports
import * as vscode from 'vscode';

// Local imports
import * as logger from '@logger/logUtils';

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

  protected getWebview(): vscode.WebviewView | undefined {
    if (!this.webview) {
      logger.warn(this.channel, `Webview not attached for ${this.channel}`);
      return undefined;
    }
    return this.webview;
  }

  protected postMessage(message: { command: string; [key: string]: unknown }): void {
    const webviewView = this.getWebview();
    if (webviewView) {
      webviewView.webview.postMessage(message);
    }
  }
}
