import * as vscode from 'vscode';

import { AUTH_COMMANDS } from '@auth/constants';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { CHATGPT_AUTH } from '@shared/copy/accountAuth';
import {
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
  ONBOARDING_NARRATIVE,
  RESEARCHER_ACCESS,
} from '@shared/copy/onboarding';

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
  const createSample = `command:${EXTENSION_COMMANDS.CREATE_SAMPLE_PROJECT}`;
  const openWalkthrough = `command:${EXTENSION_COMMANDS.OPEN_GETTING_STARTED}`;
  const signInChatGpt = 'command:texra.auth.chatgpt.signIn';
  const setApiKey = `command:${EXTENSION_COMMANDS.SET_API_KEY}`;
  const signInTexra = `command:${AUTH_COMMANDS.SIGN_IN}`;
  const docs = 'https://texra.ai';

  return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline';"
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
    h1 {
      margin: 0 0 8px;
      font-size: 1.25rem;
      line-height: 1.25;
    }
    p { margin: 0 0 12px; }
    .muted { color: color-mix(in srgb, var(--vscode-foreground) 70%, transparent); }
    ol { margin: 0 0 14px; padding-left: 22px; }
    li { margin-bottom: 6px; }
    .actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
      margin: 8px 0 16px;
    }
    .section-label {
      margin: 14px 0 4px;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.85em;
      letter-spacing: 0.04em;
      color: color-mix(in srgb, var(--vscode-foreground) 80%, transparent);
    }
    a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    a:hover {
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
      text-decoration: underline;
    }
    .button {
      display: block;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 7px 10px;
      text-align: center;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .button:hover {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-hoverBackground);
      text-decoration: none;
    }
    .secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .secondary:hover {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .link-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <h1>Welcome to TeXRA</h1>
  <p>
    TeXRA coordinates
    specialized agents to edit manuscripts, derive results, draw figures,
    and verify proofs.
  </p>
  <p>${ONBOARDING_NARRATIVE}</p>
  <ol>
    <li>Connect a credential: ${ONBOARDING_CHOICE_CHATGPT.label} or a provider API key. You can do that right here.</li>
    <li>Open a single-folder workspace containing your LaTeX project, or start with the sample project.</li>
    <li>Run setup once to check LaTeX, apply the right team, and launch the first review.</li>
  </ol>
  <p class="section-label">Connect</p>
  <div class="actions">
    <a class="button secondary" href="${signInChatGpt}">${CHATGPT_AUTH.signInLabel}</a>
    <a class="button secondary" href="${setApiKey}">Set API key &mdash; ${ONBOARDING_CHOICE_API_KEY.description}</a>
  </div>
  <p class="muted">
    Signing in to your ${RESEARCHER_ACCESS.label} separately unlocks the hosted
    research-agent catalog, including the orchestrator.
    <a href="${signInTexra}">Sign In</a>
  </p>
  <p class="section-label">Open your project</p>
  <div class="actions">
    <a class="button" href="${openFolder}">Open Folder</a>
    <a class="button secondary" href="${createSample}">Try the Sample Project</a>
  </div>
  <div class="link-list">
    <a href="${openWalkthrough}">Open walkthrough</a>
    <a href="${cloneRepo}">Clone repository</a>
    <a href="${docs}">Read docs</a>
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
