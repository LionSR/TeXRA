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
      font-family: var(--vscode-font-family, ui-sans-serif, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: transparent;
      padding: 16px;
      line-height: 1.5;
    }
    p { margin: 0 0 12px; }
    .muted { color: color-mix(in srgb, var(--vscode-foreground) 70%, transparent); }
    ol { margin: 0 0 12px; padding-left: 22px; }
    li { margin-bottom: 6px; }
    .actions { display: flex; flex-direction: column; gap: 6px; margin: 16px 0; }
    a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    a:hover {
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <p>
    <strong>Welcome to TeXRA</strong> — an AI research assistant for LaTeX. It
    coordinates specialized agents to edit manuscripts, derive results, draw
    figures, and verify proofs.
  </p>
  <p><strong>To get started:</strong></p>
  <ol>
    <li>Open a folder containing your LaTeX project (or create a sample).</li>
    <li>TeXRA will reload and walk you through sign-in or API key setup.</li>
    <li>Pick an input file, choose the orchestrator, and hit Execute.</li>
  </ol>
  <div class="actions">
    <a href="${openFolder}">Open Folder</a>
    <a href="${cloneRepo}">Clone Repository</a>
    <a href="${docs}">Read the docs</a>
  </div>
  <p class="muted">
    TeXRA needs a single-folder workspace. Multi-root workspaces aren't
    supported &mdash; open one folder at a time.
  </p>
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
