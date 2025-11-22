import * as vscode from 'vscode';
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

    // Show profile info in a message
    const info = [
      `**TeXRA Account**`,
      ``,
      `Email: ${user.email || 'N/A'}`,
      `User ID: ${user.id}`,
      `Tier: ${tier}`,
      ``,
      tier === 'free'
        ? `Upgrade to premium to access remote agents`
        : `You have access to premium remote agents`,
    ].join('\n');

    // Create a simple webview or use QuickPick to show info
    const panel = vscode.window.createWebviewPanel(
      'texraProfile',
      'TeXRA Profile',
      vscode.ViewColumn.One,
      {},
    );

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
              background: ${tier === 'premium' ? 'var(--vscode-badge-background)' : 'var(--vscode-inputValidation-warningBackground)'};
              color: ${tier === 'premium' ? 'var(--vscode-badge-foreground)' : 'var(--vscode-inputValidation-warningForeground)'};
              text-transform: uppercase;
              font-size: 0.9em;
            }
          </style>
        </head>
        <body>
          <h1>TeXRA Account</h1>
          <div class="info-row">
            <span class="label">Email:</span> ${user.email || 'N/A'}
          </div>
          <div class="info-row">
            <span class="label">User ID:</span> ${user.id}
          </div>
          <div class="info-row">
            <span class="label">Tier:</span> <span class="tier-badge">${tier}</span>
          </div>
          <div class="info-row" style="margin-top: 20px;">
            ${
              tier === 'free'
                ? '<p>Upgrade to premium to access remote agents and advanced features.</p>'
                : '<p>You have access to premium remote agents.</p>'
            }
          </div>
        </body>
      </html>
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`Failed to load profile: ${message}`);
  }
}

/**
 * Command to check authentication status (for status bar, etc.).
 */
export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
  tier?: 'free' | 'premium';
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
