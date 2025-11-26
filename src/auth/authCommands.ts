import * as vscode from 'vscode';
import { ProfileViewProvider } from '@profileView/ProfileViewProvider';
import { SupabaseClient } from './SupabaseClient';
import { SupabaseAuthProvider } from './SupabaseAuthProvider';

/**
 * Command identifiers for auth-related commands.
 */
export const AUTH_COMMANDS = {
  SIGN_IN: 'texra.auth.signIn',
  SIGN_OUT: 'texra.auth.signOut',
  VIEW_PROFILE: 'texra.auth.viewProfile',
  ACCOUNT_MENU: 'texra.auth.accountMenu',
} as const;

// Singleton instance of ProfileViewProvider
let profileViewProvider: ProfileViewProvider | null = null;

/**
 * Initialize the profile view provider.
 * Must be called during extension activation.
 */
export function initializeProfileViewProvider(
  context: vscode.ExtensionContext,
): ProfileViewProvider {
  if (!profileViewProvider) {
    profileViewProvider = new ProfileViewProvider(context);
  }
  return profileViewProvider;
}

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
 * Uses the ProfileViewProvider for consistent webview architecture.
 */
export async function viewProfile(): Promise<void> {
  if (!profileViewProvider) {
    void vscode.window.showErrorMessage(
      'Profile view not initialized. Please reload the extension.',
    );
    return;
  }

  try {
    await profileViewProvider.showProfileView();
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
        await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
      }
    } else {
      // Signed in - show profile and sign out options
      const items = [
        {
          label: '$(account) View Profile',
          description: `Signed in as ${status.email || 'unknown'} (${status.tier} tier)`,
          action: 'viewProfile' as const,
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
            await vscode.commands.executeCommand(AUTH_COMMANDS.VIEW_PROFILE);
            break;
          case 'signOut':
            await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
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
