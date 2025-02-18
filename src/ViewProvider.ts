// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { WebviewMessageHandler } from './webview/MessageHandler';
import { WebviewContentProvider } from './webview/WebviewContentProvider';

export class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  private messageHandler: WebviewMessageHandler;
  private contentProvider: WebviewContentProvider;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.messageHandler = new WebviewMessageHandler(context);
    this.contentProvider = new WebviewContentProvider(context);
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'node_modules',
          '@vscode',
          'codicons',
          'dist',
        ),
      ],
    };

    webviewView.webview.html = this.contentProvider.getHtmlContent(
      webviewView.webview,
    );

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.messageHandler.handleMessage(message, webviewView);
    });

    webviewView.webview.postMessage({ command: 'requestBaseFile' });
  }
}
