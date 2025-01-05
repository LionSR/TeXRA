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
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'src', 'logView'),
      ],
    };

    // Set the webview title
    webviewView.title = this._viewTitle;

    // Add visibility change handler
    this._disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this._updateWebview();
        }
      }),
    );

    this._updateWebview();

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
    });

    // Register disposable for cleanup
    this._disposables.push(
      webviewView.onDidDispose(() => {
        this._view = undefined;
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

    return `<!DOCTYPE html>
    <html>
      <head>
        <style>
          :root {
            /* Colors */
            --background-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --button-background: var(--vscode-button-background);
            --button-foreground: var(--vscode-button-foreground);
            --button-hover-background: var(--vscode-button-hoverBackground);
            --input-background: var(--vscode-input-background);
            --input-foreground: var(--vscode-input-foreground);
            --input-border: var(--vscode-input-border);
            --panel-border: var(--vscode-panel-border);
            --list-hover-background: var(--vscode-list-hoverBackground);
            --list-active-selection-background: var(--vscode-list-activeSelectionBackground);
            --list-active-selection-foreground: var(--vscode-list-activeSelectionForeground);
            --description-foreground: var(--vscode-descriptionForeground);
            
            /* Typography */
            --font-family: var(--vscode-font-family);
            --font-size: var(--vscode-font-size);
            --font-weight: var(--vscode-font-weight);
          }

          body {
            padding: 0;
            margin: 0;
            display: flex;
            height: 100vh;
            font-family: var(--font-family);
            font-size: var(--font-size);
            background: var(--background-color);
            color: var(--text-color);
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
            border-left: 1px solid var(--panel-border);
            height: 100%;
            overflow: hidden;
          }

          .tabs-content {
            flex: 1;
            overflow-y: auto;
            min-height: 0;
          }
          
          .clear-all-container {
            flex-shrink: 0;
            background: var(--background-color);
            border-top: 1px solid var(--panel-border);
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
            color: var(--text-color);
            font-family: var(--font-family);
            font-size: 11px;
          }

          .delete-button {
            color: #ff6b6b;
          }

          .clear-button:hover, .delete-button:hover {
            background: var(--list-hover-background);
          }

          .delete-button:hover {
            background: rgba(255, 0, 0, 0.1);
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
            color: var(--text-color);
            text-align: left;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-family: var(--font-family);
          }

          .tab:hover {
            background: var(--list-hover-background);
          }

          .tab.active {
            background: var(--list-active-selection-background);
            color: var(--list-active-selection-foreground);
          }

          .log-container {
            flex: 1;
            overflow-y: auto;
            padding: 2px 4px;
            white-space: pre;
            min-width: 0;
            min-height: 0;
          }

          .log-header {
            padding: 2px 4px;
            font-size: 11px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: var(--description-foreground);
          }

          .workspace-name {
            color: var(--description-foreground);
            font-size: 10px;
            padding: 2px 4px;
            border-bottom: 1px solid var(--panel-border);
          }

          .header-actions {
            display: flex;
            gap: 4px;
          }

          .button {
            background: none;
            border: none;
            color: var(--button-foreground);
            cursor: pointer;
            font-size: 11px;
            padding: 0 4px;
          }

          .button:hover {
            color: var(--button-hover-background);
          }

          .debug { color: #0087ff; }
          .info { color: #00af00; }
          .warn { color: #ffaf00; }
          .error { color: #ff0000; }
        </style>
      </head>
      <body>
        <div class="main-container">
          <div class="content-area">
            <div class="log-header">
              <span>${currentStream}</span>
              <div class="header-actions">
                <button class="clear-button" onclick="clearStream()">
                  <span class="x-icon">✕</span> Clear
                </button>
                <button class="delete-button" onclick="deleteStream()">
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
                    }" onclick="switchStream('${stream}')">${stream}</button>`,
                )
                .join('')}
            </div>
            <div class="clear-all-container">
              <button class="clear-button danger" onclick="clearAll()">
                <span class="x-icon">✕</span> Clear All
              </button>
            </div>
          </div>
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          let currentStream = '${currentStream}';

          function formatLogEntry(logMessage) {
            return \`<span class="\${logMessage.level}">\${logMessage.message}</span>\`;
          }

          function switchStream(stream) {
            currentStream = stream;
            document.querySelector('.log-header span').textContent = stream;
            document.querySelectorAll('.tab').forEach(tab => {
              tab.classList.toggle('active', tab.textContent === stream);
            });
            vscode.postMessage({ command: 'switchStream', stream });
          }

          function clearStream() {
            vscode.postMessage({ command: 'clearStream', stream: currentStream });
          }

          function clearAll() {
            vscode.postMessage({ command: 'clearAll' });
          }

          function deleteStream() {
            vscode.postMessage({ command: 'deleteStream', stream: currentStream });
          }

          window.addEventListener('message', event => {
            const message = event.data;
            const logContent = document.getElementById('logContent');
            
            switch (message.command) {
              case 'updateLogs':
                if (message.stream === currentStream) {
                  logContent.innerHTML = message.messages.map(formatLogEntry).join('\\n');
                  logContent.scrollTop = logContent.scrollHeight;
                }
                break;
              case 'appendLog':
                if (message.stream === currentStream) {
                  const formattedLog = formatLogEntry(message.logMessage);
                  if (logContent.innerHTML) {
                    logContent.innerHTML += '\\n' + formattedLog;
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
}
