// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { WebviewMessageHandler } from './webview/MessageHandler';
import { WebviewContentProvider } from './webview/WebviewContentProvider';

export class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  private messageHandler: WebviewMessageHandler;
  private contentProvider: WebviewContentProvider;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private webviewView: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.messageHandler = new WebviewMessageHandler(context);
    this.contentProvider = new WebviewContentProvider(context);
    this.setupFileWatcher();
  }

  private setupFileWatcher() {
    // Create a file system watcher for relevant file types
    const filePattern = '**/*.{tex,txt,md,cls,png,pdf,jpeg,jpg,svg,gif,bmp}';
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern);

    // Handle file changes
    this.fileWatcher.onDidCreate(() => this.refreshFiles());
    this.fileWatcher.onDidDelete(() => this.refreshFiles());

    // Dispose watcher when extension is deactivated
    this.context.subscriptions.push(this.fileWatcher);
  }

  private async refreshFiles() {
    if (this.webviewView) {
      await this.messageHandler.handleMessage(
        { command: 'refreshAllFiles' },
        this.webviewView,
      );
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
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
