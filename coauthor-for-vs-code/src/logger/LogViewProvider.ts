// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { LogViewContentProvider } from './LogViewContentProvider';
import { LogViewMessageHandler } from './LogViewMessageHandler';

interface ColoredLogMessage {
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
}

// Channels that should only be written to VSCode output channel
const OUTPUT_CHANNEL_ONLY = new Set([
  'Webview',
  'TestCommands',
  'fileSelectionCommands',
  'packCommands',
  'MessageHandler',
  'AgentLoad',
  'Housekeeping',
  'LaTeXCommands',
  'Utils',
]);

// Channels that should not be persisted in workspace storage
const NON_PERSISTENT_CHANNELS = new Set([...OUTPUT_CHANNEL_ONLY, 'imgUtils']);

export class LogViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _logStreams: Map<string, ColoredLogMessage[]> = new Map();
  private readonly _contentProvider: LogViewContentProvider;
  private readonly _messageHandler: LogViewMessageHandler;
  private readonly _storageKey = 'coauthor.logStreams';
  private _disposables: vscode.Disposable[] = [];
  private readonly _extensionUri: vscode.Uri;
  private readonly _viewTitle: string;
  private _viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    title: string = 'Tasks',
  ) {
    this._extensionUri = context.extensionUri;
    this._viewTitle = title;
    this._contentProvider = new LogViewContentProvider(context);
    this._messageHandler = new LogViewMessageHandler(this);
    this._loadState();

    // Listen for workspace folder changes
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._loadState();
        this._updateWebview();
      }),
    );
  }

  public dispose() {
    this._disposables.forEach((d) => d.dispose());
    this._cleanupView();
  }

  private _cleanupView() {
    // Dispose of all view-specific disposables
    this._viewDisposables.forEach((d) => d.dispose());
    this._viewDisposables = [];
    this._view = undefined;
  }

  private _getWorkspaceKey(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder
      ? `${this._storageKey}.${workspaceFolder.uri.fsPath}`
      : this._storageKey;
  }

  private _loadState() {
    const savedState = this.context.workspaceState.get<{
      [key: string]: ColoredLogMessage[];
    }>(this._getWorkspaceKey());
    if (savedState) {
      // Only load channels that are not in the blacklist
      this._logStreams = new Map(
        Object.entries(savedState).filter(
          ([channel]) => !NON_PERSISTENT_CHANNELS.has(channel),
        ),
      );
    } else {
      this._logStreams.clear();
    }
  }

  private _saveState() {
    // Only save channels that are not in the blacklist
    const persistentStreams = Array.from(this._logStreams.entries()).filter(
      ([channel]) => !NON_PERSISTENT_CHANNELS.has(channel),
    );
    const stateObj = Object.fromEntries(persistentStreams);
    this.context.workspaceState.update(this._getWorkspaceKey(), stateObj);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Clean up old view if it exists
    this._cleanupView();

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'src', 'logger', 'logView'),
        vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'split.js'),
      ],
    };

    // Set the webview title
    webviewView.title = this._viewTitle;

    // Add visibility change handler
    this._viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this._updateWebview();
        }
      }),
    );

    // Handle theme changes
    this._viewDisposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (webviewView.visible) {
          this._updateWebview();
        }
      }),
    );

    // Set initial HTML content
    webviewView.webview.html = this._contentProvider.getHtmlContent(
      webviewView.webview,
    );

    // Initialize webview with current state
    this._updateWebview();

    // Handle webview messages
    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(async (message) => {
        await this._messageHandler.handleMessage(message, webviewView);
      }),
    );

    // Register disposable for cleanup
    this._viewDisposables.push(
      webviewView.onDidDispose(() => {
        this._cleanupView();
      }),
    );
  }

  private _updateWebview() {
    if (!this._view) return;

    const streams = Array.from(this._logStreams.keys());
    const currentStream = streams[0] || '';

    this._view.webview.postMessage({
      command: 'updateStreams',
      streams,
      currentStream,
    });
    this.updateLogContent(currentStream);
  }

  public addLogMessage(
    stream: string,
    message: string,
    level: 'error' | 'warn' | 'info' | 'debug' = 'info',
  ) {
    // Skip if this stream should only be written to output channel
    if (OUTPUT_CHANNEL_ONLY.has(stream)) {
      return;
    }

    if (!this._logStreams.has(stream)) {
      this._logStreams.set(stream, []);
      this._updateWebview();
    }

    const logMessage: ColoredLogMessage = {
      message,
      level,
    };

    const messages = this._logStreams.get(stream)!;
    messages.push(logMessage);

    if (messages.length > 1000) {
      messages.splice(0, messages.length - 1000);
    }

    this._saveState();

    if (this._view) {
      this._view.webview.postMessage({
        command: 'appendLog',
        stream: stream,
        logMessage,
      });
    }
  }

  public updateLogContent(stream: string) {
    if (!this._view) return;

    // If no stream is provided or stream doesn't exist, use the first available stream
    if (!stream || !this._logStreams.has(stream)) {
      const streams = Array.from(this._logStreams.keys());
      stream = streams[0] || '';
    }

    if (!this._logStreams.has(stream)) return;

    const messages = this._logStreams.get(stream)!;
    this._view.webview.postMessage({
      command: 'updateLogs',
      stream: stream,
      messages: messages,
    });
  }

  public getLogStreams(): Map<string, ColoredLogMessage[]> {
    return this._logStreams;
  }

  public clearStream(stream: string) {
    if (this._logStreams.has(stream)) {
      this._logStreams.get(stream)!.length = 0;
      this._saveState();
      this.updateLogContent(stream);
    }
  }

  public clearAllStreams() {
    this._logStreams.clear();
    this._saveState();
    if (this._view) {
      this._view.webview.postMessage({ command: 'clearLogs' });
      this._updateWebview();
    }
  }

  public deleteStream(stream: string) {
    if (this._logStreams.has(stream)) {
      this._logStreams.delete(stream);
      this._saveState();
      this._updateWebview();
    }
  }
}
