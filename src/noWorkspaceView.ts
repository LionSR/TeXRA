import * as vscode from 'vscode';
import { nanoid } from 'nanoid';

// Reuses the `texra.mainView` slot declared in package.json so the TeXRA
// sidebar icon shows the welcome UI instead of nothing when the extension
// can't fully activate. The real MainViewProvider is only registered by
// registerCommands() in the single-folder path, so the two registrations
// never collide. The `texra.activated` context key gates view/title menu
// contributions so their commands (registered only after full activation)
// don't leak into the welcome toolbar.
const VIEW_ID = 'texra.mainView';

export type NoWorkspaceReason = 'empty' | 'multi-root';

const COPY: Record<NoWorkspaceReason, { heading: string; body: string }> = {
  empty: {
    heading: 'Welcome to TeXRA',
    body: 'Open a folder to start using TeXRA, your AI-powered LaTeX research assistant.',
  },
  'multi-root': {
    heading: 'Single-folder workspace required',
    body: 'TeXRA supports one folder at a time. Open a single folder to continue.',
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function getHtml(
  webview: vscode.Webview,
  nonce: string,
  reason: NoWorkspaceReason,
): string {
  const cspSource = webview.cspSource;
  const { heading, body } = COPY[reason];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} vscode-resource: 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource} vscode-resource:; img-src ${cspSource} vscode-resource: data:;"
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
    <h2>${escapeHtml(heading)}</h2>
    <p>${escapeHtml(body)}</p>
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
  reason: NoWorkspaceReason,
): void {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getHtml(
        webviewView.webview,
        nanoid(32),
        reason,
      );
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
      if (vscode.workspace.workspaceFolders?.length === 1) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  );
}
