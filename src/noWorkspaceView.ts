import * as vscode from 'vscode';
import { nanoid } from 'nanoid';

// Reuses the `texra.mainView` slot declared in package.json so the TeXRA
// sidebar icon shows the welcome UI instead of nothing when no folder is open.
// The real MainViewProvider is only registered by registerCommands() when a
// single-folder workspace is open, so the two registrations never collide.
const VIEW_ID = 'texra.mainView';

function getHtml(webview: vscode.Webview, nonce: string): string {
  const cspSource = webview.cspSource;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <title>TeXRA</title>
    <style nonce="${nonce}">
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        padding: 16px 12px;
        line-height: 1.5;
      }
      h2 {
        margin: 0 0 8px 0;
        font-size: 1.1em;
      }
      p {
        margin: 0 0 14px 0;
        color: var(--vscode-descriptionForeground);
      }
      button {
        display: block;
        width: 100%;
        padding: 6px 10px;
        margin-bottom: 6px;
        font-family: inherit;
        font-size: inherit;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 1px solid var(--vscode-button-border, transparent);
        cursor: pointer;
      }
      button:hover {
        background: var(--vscode-button-hoverBackground);
      }
      button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button.secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }
    </style>
  </head>
  <body>
    <h2>Welcome to TeXRA</h2>
    <p>Open a folder to start using TeXRA. The extension works on a single-folder workspace.</p>
    <button id="open">Open Folder</button>
    <button id="clone" class="secondary">Clone Repository</button>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('open').addEventListener('click', () => {
        vscode.postMessage({ type: 'openFolder' });
      });
      document.getElementById('clone').addEventListener('click', () => {
        vscode.postMessage({ type: 'cloneRepo' });
      });
    </script>
  </body>
</html>`;
}

export function registerNoWorkspaceView(
  context: vscode.ExtensionContext,
): void {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getHtml(webviewView.webview, nanoid(32));
      webviewView.webview.onDidReceiveMessage(
        (message: { type?: string }) => {
          if (message?.type === 'openFolder') {
            void vscode.commands.executeCommand(
              'workbench.action.files.openFolder',
            );
          } else if (message?.type === 'cloneRepo') {
            void vscode.commands.executeCommand('git.clone');
          }
        },
        undefined,
        context.subscriptions,
      );
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (vscode.workspace.workspaceFolders?.length) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  );
}
