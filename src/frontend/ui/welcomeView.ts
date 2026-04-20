import * as vscode from 'vscode';

/**
 * No-workspace provider for `texra.mainView`. Keeping the same view id across
 * workspace states is required for VS Code to persist the user's chosen
 * location (e.g. auxiliary sidebar) — splitting into a separate welcome view
 * id caused the aux-bar position to be lost between sessions. Reloads the
 * window once a single folder is opened so the full activation path runs.
 */
class WelcomeWebviewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
    };
    webviewView.webview.html = renderWelcomeHtml();
  }
}

function renderWelcomeHtml(): string {
  const openFolder = 'command:workbench.action.files.openFolder';
  const cloneRepo = 'command:git.clone';
  const docs = 'https://texra.ai';
  const nonce = Math.random().toString(36).slice(2);

  return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
      padding: 16px;
      line-height: 1.5;
    }
    p { margin: 0 0 12px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .actions { display: flex; flex-direction: column; gap: 6px; margin: 16px 0; }
    a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <p>
    TeXRA is a multi-agent orchestration system for LaTeX research. An
    orchestrator coordinates specialized agents that derive results, verify
    proofs, run symbolic computation, generate figures, and assemble
    manuscripts &mdash; every step auditable, every citation grounded.
  </p>
  <p class="muted">
    Open a folder to begin. The TeXRA tour and commands become available once
    a workspace is open.
  </p>
  <div class="actions">
    <a href="${openFolder}">Open Folder</a>
    <a href="${cloneRepo}">Clone Repository</a>
    <a href="${docs}">Read the docs</a>
  </div>
</body>
</html>`;
}

export function registerWelcomeView(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.mainView',
      new WelcomeWebviewProvider(),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (vscode.workspace.workspaceFolders?.length === 1) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  );
}
