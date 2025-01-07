// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { WebviewContentProvider } from '../webview/WebviewContentProvider';

interface ColoredLogMessage {
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
}

export class LogViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _logStreams: Map<string, ColoredLogMessage[]> = new Map();
  private readonly _contentProvider: WebviewContentProvider;
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
    this._contentProvider = new WebviewContentProvider(context);
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
      this._logStreams = new Map(Object.entries(savedState));
    } else {
      this._logStreams.clear();
    }
  }

  private _saveState() {
    const stateObj = Object.fromEntries(this._logStreams.entries());
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
        vscode.Uri.joinPath(this._extensionUri, 'src', 'logView'),
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

    this._updateWebview();

    // Handle webview messages
    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
          case 'switchStream':
            this._updateLogContent(message.stream);
            break;
          case 'clearStream':
            if (this._logStreams.has(message.stream)) {
              this._logStreams.get(message.stream)!.length = 0;
              this._saveState();
              this._updateLogContent(message.stream);
            }
            break;
          case 'clearAll':
            this._logStreams.clear();
            this._saveState();
            this._updateWebview();
            break;
          case 'deleteStream':
            if (this._logStreams.has(message.stream)) {
              this._logStreams.delete(message.stream);
              this._saveState();
              this._updateWebview();
            }
            break;
        }
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

    this._view.webview.html = this._getHtmlContent(streams, currentStream);
    this._updateLogContent(currentStream);
  }

  public addLogMessage(
    stream: string,
    message: string,
    level: 'error' | 'warn' | 'info' | 'debug' = 'info',
  ) {
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

  private _updateLogContent(stream: string) {
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

  private _getCurrentStream(): string {
    const streams = Array.from(this._logStreams.keys());
    return streams[0] || '';
  }

  private _getHtmlContent(streams: string[], currentStream: string): string {
    // If currentStream is empty or invalid, use the first available stream
    if (!currentStream || !this._logStreams.has(currentStream)) {
      currentStream = this._getCurrentStream();
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceName = workspaceFolder
      ? workspaceFolder.name
      : 'No Workspace';

    const nonce = this._getNonce();

    return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._view?.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
          body {
            padding: 0;
            margin: 0;
            display: flex;
            height: 100vh;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
          }

          .main-container {
            display: flex;
            flex: 1;
            height: 100%;
            overflow: hidden;
          }

          .content-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
            overflow: hidden;
          }

          .tabs {
            display: flex;
            flex-direction: column;
            width: 120px;
            min-width: 120px;
            font-size: 11px;
            border-left: 1px solid var(--vscode-panel-border);
            height: 100%;
            overflow: hidden;
            background-color: var(--vscode-sideBar-background);
          }

          .tabs-content {
            flex: 1;
            overflow-y: auto;
            min-height: 0;
          }
          
          .clear-all-container {
            flex-shrink: 0;
            background-color: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            padding: 4px;
          }

          .clear-button, .delete-button {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            cursor: pointer;
            border: none;
            background: none;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: 11px;
          }

          .delete-button {
            color: var(--vscode-errorForeground, #ff6b6b);
          }

          .clear-button:hover, .delete-button:hover {
            background-color: var(--vscode-list-hoverBackground);
          }

          .delete-button:hover {
            background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
          }

          .x-icon {
            font-family: codicon;
            font-size: 14px;
          }

          .tab {
            padding: 4px 8px;
            cursor: pointer;
            border: none;
            background: none;
            color: var(--vscode-foreground);
            text-align: left;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-family: var(--vscode-font-family);
            width: 100%;
          }

          .tab:hover {
            background-color: var(--vscode-list-hoverBackground);
          }

          .tab.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
          }

          .log-container {
            flex: 1;
            overflow-y: auto;
            padding: 2px 4px;
            min-width: 0;
            min-height: 0;
            background-color: var(--vscode-editor-background);
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
          }

          .log-line {
            white-space: pre-wrap;
            word-wrap: break-word;
            word-break: break-all;
            line-height: 1.4;
            margin: 0;
            padding: 1px 0;
            display: block;
          }

          /* Timestamp color */
          .timestamp {
            color: var(--vscode-descriptionForeground);
          }

          /* Level colors */
          .level-debug {
            color: var(--vscode-debugIcon-startForeground, #0087ff);
            font-weight: bold;
          }
          .level-info {
            color: var(--vscode-notificationsInfoIcon-foreground, #00af00);
            font-weight: bold;
          }
          .level-warn {
            color: var(--vscode-editorWarning-foreground, #ffaf00);
            font-weight: bold;
          }
          .level-error {
            color: var(--vscode-editorError-foreground, #ff0000);
            font-weight: bold;
          }

          /* Message colors */
          .message-debug {
            color: var(--vscode-debugIcon-startForeground, #00ffff);
          }
          .message-info {
            color: var(--vscode-foreground, #ffffff);
          }
          .message-warn {
            color: var(--vscode-editorWarning-foreground, #ffaf00);
          }
          .message-error {
            color: var(--vscode-editorError-foreground, #ff0000);
          }

          .log-header {
            padding: 2px 4px;
            font-size: 11px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
          }

          .header-actions {
            display: flex;
            gap: 4px;
          }

          .debug, .info, .warn, .error {
            color: inherit;
          }
        </style>
      </head>
      <body>
        <div class="main-container">
          <div class="content-area">
            <div class="log-header">
              <span>${currentStream}</span>
              <div class="header-actions">
                <button class="clear-button" id="clearStreamBtn">
                  <span class="x-icon">✕</span> Clear
                </button>
                <button class="delete-button" id="deleteStreamBtn">
                  <span class="x-icon">✕</span> Delete
                </button>
              </div>
            </div>
            <div id="logContent" class="log-container"></div>
          </div>
          <div class="tabs">
            <div class="tabs-content">
              ${streams
                .map(
                  (stream) =>
                    `<button class="tab ${
                      stream === currentStream ? 'active' : ''
                    }" data-stream="${stream}">${stream}</button>`,
                )
                .join('')}
            </div>
            <div class="clear-all-container">
              <button class="clear-button danger" id="clearAllBtn">
                <span class="x-icon">✕</span> Clear All
              </button>
            </div>
          </div>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          let currentStream = '${currentStream}';

          function formatLogEntry(logMessage) {
            return logMessage.message;
          }

          // Add event listeners after DOM is loaded
          document.addEventListener('DOMContentLoaded', () => {
            // Stream switching
            document.querySelectorAll('.tab').forEach(tab => {
              tab.addEventListener('click', () => {
                const stream = tab.dataset.stream;
                currentStream = stream;
                document.querySelector('.log-header span').textContent = stream;
                document.querySelectorAll('.tab').forEach(t => {
                  t.classList.toggle('active', t.dataset.stream === stream);
                });
                vscode.postMessage({ command: 'switchStream', stream });
              });
            });

            // Clear current stream
            document.getElementById('clearStreamBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'clearStream', stream: currentStream });
            });

            // Clear all streams
            document.getElementById('clearAllBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'clearAll' });
            });

            // Delete current stream
            document.getElementById('deleteStreamBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'deleteStream', stream: currentStream });
            });
          });

          window.addEventListener('message', event => {
            const message = event.data;
            const logContent = document.getElementById('logContent');
            
            switch (message.command) {
              case 'updateLogs':
                if (message.stream === currentStream) {
                  logContent.innerHTML = message.messages.map(formatLogEntry).join('');
                  logContent.scrollTop = logContent.scrollHeight;
                }
                break;
              case 'appendLog':
                if (message.stream === currentStream) {
                  const formattedLog = formatLogEntry(message.logMessage);
                  if (logContent.innerHTML) {
                    logContent.innerHTML += formattedLog;
                  } else {
                    logContent.innerHTML = formattedLog;
                  }
                  logContent.scrollTop = logContent.scrollHeight;
                }
                break;
            }
          });
        </script>
      </body>
    </html>`;
  }

  private _getNonce() {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
