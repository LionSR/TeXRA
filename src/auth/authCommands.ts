import * as vscode from 'vscode';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import { RemoteAgentRegistry } from '@agent/remote/RemoteAgentRegistry';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { SupabaseClient } from './SupabaseClient';
import { SupabaseAuthProvider } from './SupabaseAuthProvider';

/**
 * Command to sign in to TeXRA account.
 */
export async function signIn(): Promise<void> {
  try {
    // Check if already signed in
    const existing = await vscode.authentication.getSession(
      'texra-supabase',
      [],
      {
        silent: true,
      },
    );

    if (existing) {
      const user = await SupabaseClient.getUser();
      void vscode.window.showInformationMessage(
        `Already signed in as ${user?.email || 'unknown user'}`,
      );
      return;
    }

    // Request authentication (will trigger SupabaseAuthProvider.createSession)
    const session = await vscode.authentication.getSession(
      'texra-supabase',
      [],
      {
        createIfNone: true,
      },
    );

    if (session) {
      const user = await SupabaseClient.getUser();
      const tier = await SupabaseClient.getUserTier();
      void vscode.window.showInformationMessage(
        `Signed in as ${user?.email || 'unknown user'} (${tier} tier)`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Sign in failed: ${message}`);
  }
}

/**
 * Command to sign out of TeXRA account.
 */
export async function signOut(): Promise<void> {
  try {
    const session = await vscode.authentication.getSession(
      'texra-supabase',
      [],
      {
        silent: true,
      },
    );

    if (!session) {
      void vscode.window.showInformationMessage('Not signed in');
      return;
    }

    // Confirm sign out
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to sign out?',
      { modal: true },
      'Sign Out',
    );

    if (confirm !== 'Sign Out') {
      return;
    }

    // Use authentication provider to properly sign out
    const authProvider = SupabaseAuthProvider.getInstance();
    if (authProvider) {
      await authProvider.removeSession(session.id);
      void vscode.window.showInformationMessage('Signed out successfully');
    } else {
      void vscode.window.showErrorMessage(
        'Authentication provider not available',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Sign out failed: ${message}`);
  }
}

/**
 * Command to view profile and account status.
 */
export async function viewProfile(): Promise<void> {
  try {
    const isAuth = await SupabaseClient.isAuthenticated();

    if (!isAuth) {
      const signIn = 'Sign In';
      const choice = await vscode.window.showInformationMessage(
        'You are not signed in to TeXRA',
        signIn,
      );

      if (choice === signIn) {
        await vscode.commands.executeCommand('texra.auth.signIn');
      }
      return;
    }

    const user = await SupabaseClient.getUser();
    const tier = await SupabaseClient.getUserTier();

    if (!user) {
      void vscode.window.showErrorMessage('Failed to load user profile');
      return;
    }

    // Fetch remote agents if user has researcher tier
    const remoteAgents =
      tier === 'researcher' ? await RemoteAgentLoader.listRemoteAgents() : [];

    // Register remote agents so they appear in the dropdown
    if (remoteAgents.length > 0) {
      const agentNames = remoteAgents.map((agent) => agent.name);
      RemoteAgentRegistry.registerMultiple(agentNames);
    }

    // Create webview with scripts enabled for interactivity
    const panel = vscode.window.createWebviewPanel(
      'texraProfile',
      'TeXRA Profile',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
      },
    );

    // Generate remote agents table HTML
    const agentsTableHtml =
      remoteAgents.length > 0
        ? `
        <h2>Available Remote Agents</h2>
        <table class="agents-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Description</th>
              <th>Visibility</th>
              <th>Tags</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${remoteAgents
              .map(
                (agent) => `
              <tr>
                <td class="agent-name">${escapeHtml(agent.name)}</td>
                <td>${escapeHtml(agent.description)}</td>
                <td><span class="visibility-badge visibility-${agent.visibility}">${escapeHtml(agent.visibility)}</span></td>
                <td>${agent.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ')}</td>
                <td>
                  <button class="select-btn" data-agent="${escapeHtml(agent.name)}" title="Select ${escapeHtml(agent.name)} in agent dropdown">
                    <span class="codicon codicon-arrow-right"></span> Select
                  </button>
                </td>
              </tr>
            `,
              )
              .join('')}
          </tbody>
        </table>
      `
        : tier === 'researcher'
          ? '<p class="no-agents">No remote agents available. Contact support@texra.ai for assistance.</p>'
          : '';

    panel.webview.html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: var(--vscode-font-family);
              padding: 20px;
              color: var(--vscode-foreground);
            }
            h1 {
              color: var(--vscode-textLink-foreground);
            }
            h2 {
              color: var(--vscode-foreground);
              margin-top: 30px;
              margin-bottom: 15px;
              font-size: 1.2em;
              border-bottom: 1px solid var(--vscode-panel-border);
              padding-bottom: 8px;
            }
            .info-row {
              margin: 10px 0;
            }
            .label {
              font-weight: bold;
              color: var(--vscode-textPreformat-foreground);
            }
            .tier-badge {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              background: ${tier === 'researcher' ? 'var(--vscode-badge-background)' : 'var(--vscode-inputValidation-warningBackground)'};
              color: ${tier === 'researcher' ? 'var(--vscode-badge-foreground)' : 'var(--vscode-inputValidation-warningForeground)'};
              text-transform: uppercase;
              font-size: 0.9em;
            }
            .agents-table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 10px;
            }
            .agents-table th,
            .agents-table td {
              padding: 10px 12px;
              text-align: left;
              border-bottom: 1px solid var(--vscode-panel-border);
            }
            .agents-table th {
              background: var(--vscode-editor-background);
              font-weight: 600;
              color: var(--vscode-foreground);
            }
            .agents-table tr:hover {
              background: var(--vscode-list-hoverBackground);
            }
            .agent-name {
              font-weight: 500;
              color: var(--vscode-textLink-foreground);
            }
            .visibility-badge {
              display: inline-block;
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 0.85em;
              text-transform: lowercase;
            }
            .visibility-public {
              background: var(--vscode-testing-iconPassed);
              color: white;
            }
            .visibility-researcher {
              background: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground);
            }
            .visibility-whitelist {
              background: var(--vscode-inputValidation-warningBackground);
              color: var(--vscode-inputValidation-warningForeground);
            }
            .tag {
              display: inline-block;
              padding: 2px 6px;
              margin: 2px;
              border-radius: 3px;
              background: var(--vscode-button-secondaryBackground);
              color: var(--vscode-button-secondaryForeground);
              font-size: 0.85em;
            }
            .select-btn {
              display: inline-flex;
              align-items: center;
              gap: 4px;
              padding: 6px 12px;
              background: var(--vscode-button-background);
              color: var(--vscode-button-foreground);
              border: none;
              border-radius: 4px;
              cursor: pointer;
              font-size: 0.9em;
            }
            .select-btn:hover {
              background: var(--vscode-button-hoverBackground);
            }
            .select-btn:active {
              transform: scale(0.98);
            }
            .no-agents {
              color: var(--vscode-descriptionForeground);
              font-style: italic;
            }
            .tier-info {
              margin-top: 20px;
              padding: 12px;
              background: var(--vscode-textBlockQuote-background);
              border-left: 3px solid var(--vscode-textBlockQuote-border);
              border-radius: 0 4px 4px 0;
            }
          </style>
        </head>
        <body>
          <h1>TeXRA Account</h1>
          <div class="info-row">
            <span class="label">Email:</span> ${escapeHtml(user.email || 'N/A')}
          </div>
          <div class="info-row">
            <span class="label">User ID:</span> ${escapeHtml(user.id)}
          </div>
          <div class="info-row">
            <span class="label">Tier:</span> <span class="tier-badge">${escapeHtml(tier)}</span>
          </div>
          <div class="tier-info">
            ${
              tier === 'free'
                ? '<p>Join the researcher access program to access premium remote agents.</p>'
                : '<p>You have access to premium remote agents.</p>'
            }
          </div>
          ${agentsTableHtml}
          <script>
            const vscode = acquireVsCodeApi();

            // Add click handlers to all select buttons
            document.querySelectorAll('.select-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const agentName = btn.dataset.agent;
                vscode.postMessage({
                  command: 'selectAgent',
                  agentName: agentName
                });
              });
            });
          </script>
        </body>
      </html>
    `;

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'selectAgent') {
          const agentName = message.agentName;

          // Focus the main view and select the agent
          await vscode.commands.executeCommand('texra.mainView.focus');

          try {
            const webviewView = await vscode.commands.executeCommand<
              vscode.WebviewView | undefined
            >('texra.getWebviewView');

            if (webviewView) {
              webviewView.webview.postMessage({
                command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
                state: {
                  workflowAgent: agentName,
                },
              });
              void vscode.window.showInformationMessage(
                `Remote agent "${agentName}" is now selected.`,
              );
            } else {
              void vscode.window.showWarningMessage(
                `Could not auto-select agent. Please manually select "${agentName}" in the agent dropdown.`,
              );
            }
          } catch {
            void vscode.window.showWarningMessage(
              `Could not auto-select agent. Please manually select "${agentName}" in the agent dropdown.`,
            );
          }
        }
      },
      undefined,
      [],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to load profile: ${message}`);
  }
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Command to check authentication status (for status bar, etc.).
 */
export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
  tier?: 'free' | 'researcher';
}> {
  const isAuth = await SupabaseClient.isAuthenticated();
  if (!isAuth) {
    return { authenticated: false };
  }

  const user = await SupabaseClient.getUser();
  const tier = await SupabaseClient.getUserTier();

  return {
    authenticated: true,
    email: user?.email,
    tier,
  };
}

/**
 * Command to show account menu with sign in/out and profile options.
 * Provides accessible UI for authentication actions.
 */
export async function showAccountMenu(): Promise<void> {
  try {
    const status = await getAuthStatus();

    if (!status.authenticated) {
      // Not signed in - show sign in option
      const items = [
        {
          label: '$(sign-in) Sign In',
          description:
            'Sign in to access remote agents via the researcher access program',
          action: 'signIn' as const,
        },
      ];

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Account Options',
      });

      if (choice?.action === 'signIn') {
        await vscode.commands.executeCommand('texra.auth.signIn');
      }
    } else {
      // Signed in - show profile, browse agents, and sign out options
      const items = [
        {
          label: '$(account) View Profile',
          description: `Signed in as ${status.email || 'unknown'} (${status.tier} tier)`,
          action: 'viewProfile' as const,
        },
        {
          label: '$(cloud) Browse Remote Agents',
          description: 'Explore available remote agents',
          action: 'browseAgents' as const,
        },
        {
          label: '$(sign-out) Sign Out',
          description: 'Sign out of your TeXRA account',
          action: 'signOut' as const,
        },
      ];

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Account Options',
      });

      if (choice) {
        switch (choice.action) {
          case 'viewProfile':
            await vscode.commands.executeCommand('texra.auth.viewProfile');
            break;
          case 'browseAgents':
            await vscode.commands.executeCommand('texra.remoteAgents.browse');
            break;
          case 'signOut':
            await vscode.commands.executeCommand('texra.auth.signOut');
            break;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to show account menu: ${message}`,
    );
  }
}
