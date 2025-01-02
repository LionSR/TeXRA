import * as vscode from 'vscode';
import { WebviewMessageHandler } from './webview/messageHandler';
import { WebviewContentProvider } from './webview/webviewContentProvider';
import { initializeLogging } from './logger/logUtils';

const CHANNEL = 'ViewProvider';
initializeLogging(CHANNEL);

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
